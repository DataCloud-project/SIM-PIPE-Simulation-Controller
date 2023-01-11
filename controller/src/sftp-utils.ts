import * as dotenv from 'dotenv';
import fs from 'node:fs';
import asyncFs from 'node:fs/promises';
import Client from 'ssh2-sftp-client';

import logger from './logger.js';

dotenv.config({ path: '../.env' });

// https://openbase.com/js/node-sftp-client/documentation
const sftp = new Client();

const options = {
  host: process.env.SFTP_HOST ?? process.env.SANDBOX_IP ?? 'localhost',
  port: process.env.SFTP_PORT ? Number.parseInt(process.env.SFTP_PORT, 10) : 2222,
  username: process.env.SFTP_USERNAME ?? 'user1',
  password: process.env.SFTP_PASSWORD ?? 'user1',
};

export async function putFolderToSandbox(
  localFolder: string, remoteFolder: string, targetDirectory: string,
): Promise<void> {
  // Create folder to store the simulation details
  const targetInputDirectory = `${targetDirectory}/inputs/`;
  const targetOutputDirectory = `${targetDirectory}/outputs/`;
  fs.mkdirSync(targetDirectory, { recursive: true });
  fs.mkdirSync(targetInputDirectory, { recursive: true });
  fs.mkdirSync(targetOutputDirectory, { recursive: true });

  // copy all files in localFolder to storageFolder
  const filelist = fs.readdirSync(localFolder);
  await Promise.all(filelist.map(async (f) => {
    await asyncFs.copyFile(`${localFolder}${f}`, `${targetInputDirectory}${f}`);
  }));

  // send input file to the sandbox
  try {
    await sftp.connect(options);
    await sftp.uploadDir(localFolder, remoteFolder);
    logger.info('Sent similation inputs to Sandbox');
  } finally {
    await sftp.end();
  }
}

export async function getFromSandbox(
  remoteOutputDirectory: string, storeOutputDirectory: string): Promise<void> {
  try {
    await sftp.connect(options);
    await sftp.downloadDir(remoteOutputDirectory, storeOutputDirectory);
  } finally {
    await sftp.end();
  }
}

export async function clearSandbox(): Promise<void> {
  try {
    await sftp.connect(options);
    const directoryList = ['./in/', './out/', './work/'];
    // List files in parallel
    const fileList = await Promise.all(directoryList.map(async (directory) => {
      const files = await sftp.list(directory);
      return files.map((file) => `${directory}${file.name}`);
    }));
    // Delete everything in parallel, if it's too slow or failing
    // consider using the p-limit package
    await Promise.all(fileList.flat().map(async (file) => {
      await sftp.delete(file);
      // logger.info(`Deleted ${file} from Sandbox`);
    }));
  } finally {
    await sftp.end();
    logger.info('Cleared Sandbox for next simulation');
  }
}
