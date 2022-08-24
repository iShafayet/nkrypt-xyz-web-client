import { convertSmallUint8ArrayToString } from "../utility/buffer-utils.js";
import { buildCryptoHeader } from "../utility/crypto-api-utils.js";
import {
  callBlobReadStreamApi,
  callBlobWriteStreamApi,
} from "../integration/blob-apis.js";
import {
  createEncryptionKeyFromPassword,
  decryptBuffer,
  encryptBuffer,
  makeRandomIv,
  makeRandomSalt,
} from "../utility/crypto-utils.js";

import {
  convertStreamToBuffer,
  MeteredByteStreamReader,
} from "../utility/stream-and-buffer-utils.js";
import {
  BLOB_CHUNK_SIZE_BYTES,
  IV_LENGTH,
  SALT_LENGTH,
} from "./crypto-specs.js";

const createCipherProperties = async (bucketPassword: string) => {
  let { iv } = await makeRandomIv();
  let { salt } = await makeRandomSalt();
  let { key } = await createEncryptionKeyFromPassword(bucketPassword, salt);
  return { iv, key, salt };
};

const createEncryptedPseudoTransformStream = async (
  file: File,
  cipherProps: { iv; key; salt },
  progressNotifierFn: Function,
  bucketPassword // delme
): Promise<ReadableStream<any>> => {
  const totalBytes = file.size;
  let bytesRead = 0;
  progressNotifierFn(totalBytes, bytesRead, 0);

  let inputStream: ReadableStream = file.stream() as any;
  // let inputStreamReader = inputStream.getReader();
  let meteredBytedReader = new MeteredByteStreamReader(inputStream);

  // Note: We are not using transform streams due to a lack of browser support.
  return new ReadableStream({
    async pull(controller) {
      const { value: chunk, done } = await meteredBytedReader.readBytes(
        BLOB_CHUNK_SIZE_BYTES
      );

      if (done) {
        controller.close();
        return;
      }

      let chunkBuffer: ArrayBuffer = chunk.buffer;
      let encryptedChunkBuffer = await encryptBuffer(cipherProps, chunkBuffer);

      bytesRead += chunkBuffer.byteLength;
      progressNotifierFn(totalBytes, bytesRead, 0);

      controller.enqueue(encryptedChunkBuffer);
    },
  });
};

export const encryptAndUploadFile = async (
  bucketId: string,
  fileId: string,
  file: File,
  bucketPassword: string,
  progressNotifierFn: Function
) => {
  let cipherProps = await createCipherProperties(bucketPassword);

  let encryptedDataStream = await createEncryptedPseudoTransformStream(
    file,
    cipherProps,
    progressNotifierFn,
    bucketPassword
  );

  let iv = convertSmallUint8ArrayToString(cipherProps.iv);
  let salt = convertSmallUint8ArrayToString(cipherProps.salt);
  let cryptoHeader = buildCryptoHeader(iv, salt);

  let inputStream: ReadableStream = file.stream() as any;

  let response = await callBlobWriteStreamApi(
    bucketId,
    fileId,
    file.size,
    encryptedDataStream,
    cryptoHeader
  );

  progressNotifierFn(file.size, file.size, file.size);

  return response;
};

// First IV_LENGTH bytes are IV and next SALT_LENGTH bytes are salt
const createDeryptedPseudoTransformStream = async (
  inputStream: ReadableStream,
  bucketPassword: string,
  progressNotifierFn: Function
): Promise<ReadableStream<any>> => {
  let salt: Uint8Array = null;
  let iv: Uint8Array = null;
  let key: CryptoKey = null;

  // const totalBytes = file.size;
  // let bytesRead = 0;
  // progressNotifierFn(totalBytes, bytesRead, 0);

  let inputStreamReader = inputStream.getReader();

  // Note: We are not using transform streams due to a lack of browser support.
  return new ReadableStream({
    async pull(controller) {
      let {
        value: encryptedChunk,
        done,
      }: { value?: Uint8Array | ArrayBuffer; done: boolean } =
        await inputStreamReader.read();

      if (done) {
        controller.close();
        return;
      }

      if (!encryptedChunk) {
        throw new Error("Expected encryptedChunk");
      }

      if (encryptedChunk instanceof ArrayBuffer) {
        console.log(
          "Surprisingly got ArrayBuffer where Uint8Array was expected. Moving on."
        );
      } else if (encryptedChunk instanceof Uint8Array) {
        // convert to ArrayBuffer
        encryptedChunk = encryptedChunk.buffer;
      } else {
        console.log("Invalid type", encryptedChunk);
        throw new Error("Expected encryptedChunk to be an Uint8Array.");
      }

      if (!salt && !iv) {
        // This is the first ever transmission
        console.log("FIRST DOWN COMBINED encryptedChunk", encryptedChunk);

        let encryptedChunkView = new Uint8Array(encryptedChunk);

        if (encryptedChunkView.length < IV_LENGTH + SALT_LENGTH) {
          throw new Error(
            "Unexpected edge case. Did not expect chunk to be so small"
          );
        }

        iv = encryptedChunkView.slice(0, IV_LENGTH);
        salt = encryptedChunkView.slice(IV_LENGTH, IV_LENGTH + SALT_LENGTH);
        ({ key } = await createEncryptionKeyFromPassword(bucketPassword, salt));

        let newEncryptedChunkView = encryptedChunkView.slice(
          IV_LENGTH + SALT_LENGTH,
          encryptedChunkView.length
        );
        let newEncryptedChunk = newEncryptedChunkView.buffer;

        console.log("FIRST DOWN iv", iv);
        console.log("FIRST DOWN salt", salt);
        console.log("FIRST DOWN REDUCED encryptedChunk", newEncryptedChunk);

        let decryptedChunk = await decryptBuffer(
          { iv, key },
          newEncryptedChunk
        );
        controller.enqueue(decryptedChunk);
      } else {
        let decryptedChunk = await decryptBuffer({ iv, key }, encryptedChunk);
        controller.enqueue(decryptedChunk);
      }
    },
  });
};

const initiateFileDownload = (buffer: ArrayBuffer, fileNameForDownloading) => {
  let blob = new Blob([new Uint8Array(buffer)]);

  let url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.style.display = "none";
  a.href = url;
  a.download = fileNameForDownloading;
  document.body.appendChild(a);
  a.click();

  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 100);
};

export const downloadAndDecryptFile = async (
  bucketId: string,
  fileId: string,
  fileNameForDownloading: string,
  bucketPassword: string,
  progressNotifierFn: Function
) => {
  let response = await callBlobReadStreamApi(bucketId, fileId);

  if (response.hasError) {
    return response;
  }

  let decryptedReadableStream = await createDeryptedPseudoTransformStream(
    response.readableStream,
    bucketPassword,
    progressNotifierFn
  );

  // TODO: Investigate ways to save file directly from stream
  let buffer = await convertStreamToBuffer(decryptedReadableStream);

  initiateFileDownload(buffer, fileNameForDownloading);

  return response;
};