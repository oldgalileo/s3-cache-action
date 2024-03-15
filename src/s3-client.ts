import * as core from "@actions/core";
import * as s3 from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import * as fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { Env, Inputs } from "./constants";

export class S3Client {
  private readonly client: s3.S3Client;
  private readonly bucketName: string;

  constructor() {
    const region = S3Client.getInput("AWSRegion");
    const accessKeyId = S3Client.getInput("AWSAccessKeyId");
    const secretAccessKey = S3Client.getInput("AWSSecretAccessKey");
    const sessionToken = S3Client.getInput("AWSSessionToken");
    this.client = new s3.S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey, sessionToken },
    });
    this.bucketName = core.getInput(Inputs.BucketName, { required: true });
  }

  private static getInput(key: keyof typeof Inputs & keyof typeof Env): string {
    const value =
      core.getState(Env[key]) || core.getInput(Inputs[key]) || process.env[Env[key]] || "";
    core.saveState(Env[key], value);
    return value;
  }

  private static joinKey(key: string, file: string): string {
    return `${key}/${file}`;
  }

  private static matchFile(objectKey: string, file: string): boolean {
    return objectKey.endsWith(`/${file}`);
  }

  private static getKey(objectKey: string): string {
    const index = objectKey.lastIndexOf("/");
    if (index === -1) {
      throw new Error(`Invalid object key: ${objectKey}`);
    }
    return objectKey.substring(0, index);
  }

  async getObject(key: string, file: string, stream: fs.WriteStream): Promise<boolean> {
    core.debug(`Getting object from S3 with key ${key}, file ${file}.`);
    const command = new s3.GetObjectCommand({
      Bucket: this.bucketName,
      Key: S3Client.joinKey(key, file),
    });
    try {
      const response = await this.client.send(command);
      await pipeline(response.Body! as Readable, stream);
      return true;
    } catch (error: unknown) {
      if (error instanceof s3.NoSuchKey) {
        return false;
      }
      throw error;
    }
  }

  async headObject(key: string, file: string): Promise<boolean> {
    core.debug(`Heading object from S3 with key ${key}, file ${file}.`);
    const command = new s3.HeadObjectCommand({
      Bucket: this.bucketName,
      Key: S3Client.joinKey(key, file),
    });
    try {
      await this.client.send(command);
      return true;
    } catch (error: unknown) {
      if (error instanceof s3.NotFound) {
        return false;
      }
      throw error;
    }
  }

  async listObjects(prefix: string, file: string): Promise<string[]> {
    core.debug(`Listing objects from S3 with prefix ${prefix}.`);
    const command = new s3.ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
    });
    const response = await this.client.send(command);
    if (response.IsTruncated) {
      core.info(
        `Too many objects in S3 with prefix ${prefix}, ` +
          `only ${response.KeyCount} objects will be checked.`,
      );
    }
    return (
      response.Contents?.filter((object) => S3Client.matchFile(object.Key!, file))
        .sort((x, y) => (x.LastModified!.getTime() < y.LastModified!.getTime() ? 1 : -1))
        .map((object) => S3Client.getKey(object.Key!)) ?? []
    );
  }

  async putObject(key: string, file: string, stream: fs.ReadStream): Promise<void> {
    core.debug(`Putting object to S3 with key ${key}, file ${file}.`);
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucketName,
        Key: S3Client.joinKey(key, file),
        Body: stream,
      },
    });
    upload.on("httpUploadProgress", ({ loaded, total }) => {
      core.debug(`Uploaded ${loaded} of ${total} bytes.`);
    });
    await upload.done();
  }
}
