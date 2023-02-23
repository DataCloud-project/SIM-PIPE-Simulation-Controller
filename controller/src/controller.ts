import { captureException, init as SentryInit } from '@sentry/node';
import Docker from 'dockerode';
import * as dotenv from 'dotenv';
import fsAsync from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { clearIntervalAsync } from 'set-interval-async';
import { setIntervalAsync } from 'set-interval-async/dynamic';
import type { GraphQLClient } from 'graphql-request';
import type { Stream } from 'node:stream';
import type { SetIntervalAsyncTimer } from 'set-interval-async';

import { getSdk } from './db/database.js';
import logger from './logger.js';
import * as sftp from './sftp-utils.js';
import type * as types from './types.js';

dotenv.config();

// TODO: remove global variables

if (process.env.SENTRY_DSN) {
  SentryInit({
    dsn: process.env.SENTRY_DSN,
  });
} else {
  SentryInit({
    dsn: '',
    // eslint-disable-next-line unicorn/no-null
    beforeSend: () => null,
  });
}

captureException(new Error('Test Sentry'));

// remote is true by default
const remote: boolean = process.argv[2] ? process.argv[2] === 'remote' : true;

let docker: Docker;
let sdk: ReturnType<typeof getSdk>;

if (remote) {
  const host = process.env.SANDBOX_IP ?? process.env.DOCKER_HOST ?? 'localhost';

  const caCertPath = process.env.SANDBOX_CA_CERT ?? process.env.DOCKER_TLS_CA_CERT ?? '';
  const caCert = caCertPath ? await fsAsync.readFile(caCertPath) : undefined;

  const tlsCertPath = process.env.SANDBOX_TLS_CERT ?? process.env.DOCKER_TLS_CERT ?? '';
  const tlsCert = tlsCertPath ? await fsAsync.readFile(tlsCertPath) : undefined;

  const tlsKeyPath = process.env.SANDBOX_TLS_KEY ?? process.env.DOCKER_TLS_KEY ?? '';
  const tlsKey = tlsKeyPath ? await fsAsync.readFile(tlsKeyPath) : undefined;

  const protocol = (process.env.SANDBOX_TLS_VERIFY ?? process.env.DOCKER_TLS_VERIFY)
    ? 'https' : 'http';

  const port = process.env.SANDBOX_PORT ?? process.env.DOCKER_PORT ?? (
    protocol === 'https' ? 2376 : 2375
  );

  // remote connection to docker daemon
  docker = new Docker({
    host,
    port,
    protocol,
    ca: caCert,
    cert: tlsCert,
    key: tlsKey,
  });
} else {
  // local connection to docker dameon
  const socket = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
  const stats = await fsAsync.stat(socket);

  if (!stats.isSocket()) {
    throw new Error('🎌 Are you sure the docker is running?');
  }

  docker = new Docker({ socketPath: socket });
}

const SFTP_VOLUME_LOCATION = process.env.SFTP_VOLUME_NAME
  ?? '/var/lib/docker/volumes/sandbox_sftp_data/_data/user1';

// Ping docker deamon to check if it is running
async function pingDocker(): Promise<void> {
  try {
    const pingResult = await Promise.race<string | unknown>([
      setTimeout(5000, 'timeout'),
      docker.ping(),
    ]);
    if (pingResult === 'timeout') {
      throw new Error('ping timeout');
    }
    logger.info('🐳 Docker daemon is running');
  } catch (error) {
    logger.error('🐳 Docker daemon is not running');
    captureException(error);
    throw new Error(`🎌 Error pinging docker daemon\n${error as string}`);
  }
}
await pingDocker();

let targetDirectory: string;
let createdContainer: Docker.Container;
let counter: number;

function init(step: types.Step): void {
  if (!step.stepNumber) {
    throw new Error('🎌 Error in controller.init: step number not defined');
  }
  targetDirectory = path.join('/app/simulations', step.simId, step.runId, `${step.stepNumber}`);
  counter = 1;
  process.env.PROCESS_COMPLETED = 'false';
  process.env.STOP_SIGNAL_SENT = 'false';
}
let timer: SetIntervalAsyncTimer<void[]>;

async function pullImagePromise(image: string): Promise<void> {
  // Do nothing if the image already exist
  const images = await docker.listImages();
  // If a tag is not included at the end, add the :latest tag
  const imageWithTag = /:\w+$/.test(image) ? image : `${image}:latest`;
  if (images.some((img) => img.RepoTags?.includes(imageWithTag))) {
    // eslint-disable-next-line unicorn/no-useless-promise-resolve-reject
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const onFinished = (): void => {
      resolve();
    };
    // eslint-disable-next-line no-void
    void docker.pull(image, async (error: unknown, stream: Stream) => {
      if (error) {
        reject(error);
      } else {
        try {
          docker.modem.followProgress(stream, onFinished);
        } catch (dockerModemError) {
          if ((dockerModemError as Error).name === 'TypeError') {
            resolve();
          } else {
            captureException(dockerModemError);
            reject(dockerModemError);
          }
        }
      }
    });/* ;.catch((error) => {
      reject(error);
    }); */
  });
}

async function startContainer(
  image: string, stepId: number, environment: string[],
): Promise<number> {
  await pullImagePromise(image); // pull docker image before creating container
  createdContainer = (await docker.createContainer({
    Image: image,
    Tty: true,
    // Volume specified in docker createcontainer function using Binds parameter
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - Binds is missing from ContainerCreateOptions type
    // the as unknown as Docker.Container is also related to this mess
    // TODO make a pull request there to add the Binds type
    // https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/dockerode
    Binds: [
      `${SFTP_VOLUME_LOCATION}/in:/app/in`,
      `${SFTP_VOLUME_LOCATION}/out:/app/out`,
      `${SFTP_VOLUME_LOCATION}/work:/app/work`,
    ],
    StopTimeout: process.env.CONTAINER_STOP_TIMEOUT ? +process.env.CONTAINER_STOP_TIMEOUT : 5,
    Env: environment || [],
  })) as unknown as Docker.Container;
  await createdContainer.start({});
  const startedAt = new Date() as unknown as number;
  // change the step status in the database to active
  await sdk.setStepAsStarted({ step_id: stepId });
  logger.info(`Container started with ID: ${createdContainer.id}`);
  return startedAt;
}

export async function parseStats(stepId: number): Promise<void> {
  const directoryName = targetDirectory;
  const fileList = await fsAsync.readdir(directoryName);

  // Load all the files in parallel
  const stats = await Promise.all(fileList
    // Only load files following the stats.${counter}.json pattern
    .filter((fileName) => /^stats\.\d+\.json$/.test(fileName))
    .map(async (fileName) => {
      const fullFilename = path.join(directoryName, fileName);
      const data = await fsAsync.readFile(fullFilename, { encoding: 'utf8' });

      let sample: types.StatSample;
      try {
        const fileContent = JSON.parse(data) as {
          read: string;
          cpu_stats: {
            cpu_usage: {
              total_usage: number;
            };
            system_cpu_usage: number;
          };
          memory_stats: {
            usage: number;
            max_usage: number;
          };
          networks: {
            eth0: {
              rx_bytes: number;
              tx_bytes: number;
            };
          };
        };

        if (fileContent.read.startsWith('0001-01-01T00:00:00Z')) {
          // Delete stats file with null values
          await fsAsync.unlink(fullFilename);
          return undefined;
        }

        const time = fileContent.read;
        const cpu = fileContent.cpu_stats.cpu_usage.total_usage;
        const systemCpu = fileContent.cpu_stats.system_cpu_usage;
        const memory = fileContent.memory_stats.usage;
        const memoryMax = fileContent.memory_stats.max_usage;
        const rxValue = fileContent.networks.eth0.rx_bytes;
        const txValue = fileContent.networks.eth0.tx_bytes;
        sample = {
          time, cpu, systemCpu, memory, memory_max: memoryMax, rxValue, txValue,
        };
      } catch (error) {
        captureException(error);
        logger.error(`🎌 Error parsing stats file: ${fullFilename}`);
        logger.error(error);
        return undefined;
      }
      // Delete temporary stat file after extracting required values
      await fsAsync.unlink(fullFilename);
      return sample;
    }));

  const definedStats = stats.filter((stat): stat is types.StatSample => stat !== undefined);

  // We need to sort the stats by timestamp because we read them in parallel
  const sortedStats = definedStats.sort((a, b) => a.time.localeCompare(b.time));

  // test: adding cpu percentage
  let previousCpu = 0;
  let previousSystemCpu = 0;
  for await (const currentStats of sortedStats) {
    const temporary = currentStats.cpu;
    currentStats.cpu = Math.round(
      ((currentStats.cpu - previousCpu) / (currentStats.systemCpu - previousSystemCpu)) * 1000,
    ) / 1000;
    await sdk.insertResourceUsage({
      cpu: currentStats.cpu,
      memory: currentStats.memory,
      memory_max: currentStats.memory_max,
      rx_value: currentStats.rxValue,
      tx_value: currentStats.txValue,
      step_id: stepId,
      time: currentStats.time,
    });
    previousCpu = temporary;
    previousSystemCpu = currentStats.systemCpu;
  }

  const json = JSON.stringify(sortedStats, undefined, ' ');
  await fsAsync.appendFile(path.join(directoryName, 'statistics.json'), json);
}

function stopPollingStats(): void {
  clearIntervalAsync(timer).catch((error) => {
    logger.error(error);
  });
}

async function postExitProcessing(
  container: Docker.Container, stepId: number, stepNumber: number,
): Promise<void> {
  await setTimeout(1000); // Wait 1s before parsing the stats
  await parseStats(stepId);
  // collect logs of the stoppped container
  const logStream = await container.logs({
    follow: false, stdout: true, stderr: true,
  });
  // Convert the log Buffer to a string
  const logText = logStream.toString('utf8');
  // get output from sandbox
  const remoteOutDirectory = process.env.REMOTE_OUTPUT_DIR ?? 'out/';
  await sftp.getFromSandbox(remoteOutDirectory,
    `${targetDirectory}/outputs`);
  logger.info('Collected simulation files from Sandbox');
  const result = await createdContainer.inspect();
  const exitCode = result.State.ExitCode;
  logger.info(`Exit code ${exitCode}`);
  if (exitCode === 0  || exitCode === 15) { // graceful termination/sucessful completion
    await sdk.insertLog({ step_id: stepId, text: logText });
    // update the step status as ended succesfully
    await sdk.setStepAsEndedSuccess({
      step_id: stepId,
      started: result.State.StartedAt,
      ended: result.State.FinishedAt,
    });
  }
  // clear all files created during simulation
  await sftp.clearSandbox();
  logger.info(`Stored simulation details to ${targetDirectory}`);
  // set variable COMPLETED to indicate completion of simulation
  process.env.PROCESS_COMPLETED = 'true';
  logger.info(`Step ${stepNumber} finished execution\n`);
}

async function getStatsUntilExit(
  container: Docker.Container, exitTimeout: number, startedAt: number, step: types.Step,
): Promise<void> {
  // if container stops, then stop the timer
  const containers = await docker.listContainers();
  const ids = containers.map((containerInList) => containerInList.Id);

  if (ids.includes(createdContainer.id)) { // collect statstics as long as the container is running
    if (process.env.STOP_SIGNAL_SENT === 'false'
      && ((process.env.CANCEL_RUN_LIST as string).includes(step.runId)
        || (exitTimeout !== 0 && ((new Date() as unknown as number) - startedAt) >= exitTimeout))) {
      try {
        // for continuous steps, send stop signal after configured number of seconds
        await createdContainer.stop();
        // set STOP_SIGNAL_SENT to true to avoid sending multiple stop signals
        process.env.STOP_SIGNAL_SENT = 'true';
        logger.info('Sent stop signal to running container');
      } catch {
        logger.error('🎌 Error stopping the container');
      }
    }
    // TODO: very slow; takes around 2 seconds
    const stream = await container.stats({ stream: false });
    const fileName = path.join(targetDirectory,
      `stats.${counter}.json`);
    counter += 1;
    await fsAsync.writeFile(fileName, JSON.stringify(stream, undefined, ' '));
  } else { // container is exited or timedout
    stopPollingStats();
    // if run is cancelled
    if (step.stepId !== undefined && (process.env.CANCEL_RUN_LIST as string).includes(step.runId)) {
      await sdk.setStepAsCancelled({ step_id: step.stepId });
      logger.info('Step execution is cancelled');
      // clear all files created during simulation
      await sftp.clearSandbox();
      // set PROCESS_COMPLETED to indicate simulation is ready to closed
      process.env.PROCESS_COMPLETED = 'true';
    } else { // if step executed successfully
      logger.info('Completed execution of container');
      await postExitProcessing(container, step.stepId as number, step.stepNumber as number);
    }
  }
}

function startPollingStats(startedAt: number, step: types.Step): void {
  let exitTimeout: number;
  // get CONTAINER_TIME_LIMIT (seconds) env variable
  if (process.env.CONTAINER_TIME_LIMIT) {
    exitTimeout = (+process.env.CONTAINER_TIME_LIMIT) * 1000;
  } else {
    throw new Error('🎌 Timeout interval to stop container is not defined');
  }
  const pollingInterval = process.env.POLLING_INTERVAL ? +process.env.POLLING_INTERVAL * 1000
    : 750;
  timer = setIntervalAsync(async () => {
    try {
      await getStatsUntilExit(createdContainer, exitTimeout, startedAt, step);
    } catch (error) {
      captureException(error);
      logger.error(error);
    }
  }, pollingInterval);
}

async function waitForContainer(): Promise<void> {
  while (process.env.PROCESS_COMPLETED === 'false') {
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(500);
  }
}

export async function start(client: GraphQLClient, step: types.Step): Promise<string> {
  if (!step.stepNumber || !step.stepId || !step.image || !step.env) {
    throw new Error('🎌 Error in controller.start: step_number, image, env or step_id not defined');
  }
  try {
    init(step);
    sdk = getSdk(client);
    logger.info(`Starting simulation for step ${step.stepNumber}`);
    const remoteInputFolder = process.env.REMOTE_INPUT_DIR ?? 'in/';
    // to handle complex pipelines
    for await (const input of step.inputPath) {
      await sftp.putFolderToSandbox(input, remoteInputFolder, targetDirectory);
    }
    const startedAt = await startContainer(step.image, step.stepId, step.env);
    startPollingStats(startedAt, step);
    await waitForContainer();
    const result = await createdContainer.inspect();
    if (result.State.ExitCode !== 0 && result.State.ExitCode !== 15) { // exit code 15: graceful termination
      if (process.env.STOP_SIGNAL_SENT) {
        logger.error('Process was timed out before completion');
        throw new Error('Process was timed out before completion');
      }
      throw new Error(`Exit code ${result.State.ExitCode} indicates step failed`);
    }
    return `${targetDirectory}/outputs/`;
  } catch (error) {
    captureException(error);
    const message: string = error instanceof Error ? error.message : 'Error that is not an Error instance';
    // set step as failed on exception
    await sdk.setStepAsFailed({ step_id: step.stepId });
    await sdk.insertLog({ step_id: step.stepId, text: `${message}` });
    logger.error(`🎌 ${message} in controller.start`);
    throw new Error(`Error in step execution, step failed ${message}`);
  }
}
