/**
 *
 * - check ffmpeg install, if not found, abort
 * - "ssam:ffmpeg" received, set up ffmpeg encoder
 * - "ssam:ffmpeg-newframe" received, encode the frame, and when it's finished request next frame with "ssam:ffmpeg-reqframe".
 * - on client-side, it will wait until "ffmpeg-reqframe" is received and then advance time and send a new frame. (send/receive/encode is synched)
 * - when "ssam:ffmpeg-done" received, finish encoding
 *
 * FIX
 * - 4000x4000 results in pixelated video with libx264 codec.
 *   - is it codec limitation or settings?
 *   - stream chunks?
 *
 * REVIEW
 * - alternative: better handle streaming through pipe?
 * - png sequence export: don't really need to use ffmpeg for this. (cropping is done through filter, though.)
 */

import type { PluginOption, ViteDevServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { exec, spawn } from "node:child_process";
import { Readable, Writable } from "stream";
import pc from "picocolors";
import ansiRegex from "ansi-regex";

type ExportOptions = {
  /** console logging in browser */
  log?: boolean;
  /** directory to save images to */
  outDir?: string;
  /** generates ffmpeg log file for debugging by adding `-report` flag */
  debug?: boolean;
  /** how many preceding zeros to pad to filenames in image sequence */
  padLength?: number;
  /**
   * Control the flow of incoming frames by first storing in buffer array.
   * This property sets the maximum length of buffer array that temporarily holds buffer objects.
   * Lower this value if you notice freezing.
   */
  // maxBufferSize?: number;
};

const defaultOptions = {
  log: true,
  outDir: "./output",
  padLength: 5,
  debug: false,
  // maxBufferSize: 64,
};

const { gray, green, yellow, red } = pc;

const prefix = () => {
  return `${gray(new Date().toLocaleTimeString())} ${green(`[ssam-ffmpeg]`)}`;
};

const removeAnsiEscapeCodes = (str: string) => {
  return str.replace(ansiRegex(), "");
};

let isFfmpegInstalled = false;
let isFfmpegReady = false; // ready to receive a new frame?

let filename: string;
let format: string;
let width: number;
let height: number;
// TODO: use the actual frame number coming from client
let framesRecorded = 0;
let totalFrames = 0;
let cropped = false;
let msgCropped = ""; // msg to log after finishing (otherwise, the log is already far up)

export const ssamFfmpeg = (opts: ExportOptions = {}): PluginOption => ({
  name: "vite-plugin-ssam-ffmpeg",
  apply: "serve",
  async configureServer(server: ViteDevServer) {
    let { log, outDir, padLength, debug } = {
      ...defaultOptions,
      ...opts,
    };
    let subDir = ""; // will be overwritten with datatime string

    // check for ffmpeg install first when plugin is loaded
    try {
      await execPromise(`ffmpeg -version`);

      isFfmpegInstalled = true;
    } catch (error: any) {
      // if no ffmpeg, warn and abort
      const msg = `${prefix()} ${yellow(error)}`;
      log &&
        server.ws.send("ssam:warn", {
          msg: removeAnsiEscapeCodes(msg),
          abort: true,
        });
      console.warn(`${msg}`);
    }

    let stdin: Writable;
    let stdout: Readable;
    let stderr: Readable;

    // this message is received when client starts a new recording
    server.ws.on("ssam:ffmpeg", async (data, client) => {
      if (!isFfmpegInstalled) {
        const msg = `${prefix()} ffmpeg was not found`;
        log && client.send("ssam:warn", { msg: removeAnsiEscapeCodes(msg) });
        console.warn(msg);
        return;
      }

      ({ filename, format, totalFrames, width, height } = data);

      // reset frame count per each recording
      framesRecorded = 0;

      width = Math.floor(width);
      height = Math.floor(height);
      // crop to be multiples of 2
      const newWidth = width % 2 === 0 ? width : width - 1;
      const newHeight = height % 2 === 0 ? height : height - 1;

      if (width % 2 !== 0 || height % 2 !== 0) {
        cropped = true;
        msgCropped = `${prefix()} ${yellow(
          `output dimensions cropped to be multiples of 2: [${newWidth}, ${newHeight}]`,
        )}`;
      } else {
        cropped = false;
      }

      // if outDir not exist, create one
      if (!fs.existsSync(outDir)) {
        console.log(
          `${prefix()} creating a new directory at ${path.resolve(outDir)}`,
        );
        fs.mkdirSync(outDir);
      }

      if (format === "mp4") {
        const inputArgs =
          `-f image2pipe -framerate ${data.fps} -c:v png -i - -filter crop=${newWidth}:${newHeight}:0:0`.split(
            " ",
          );
        //prettier-ignore
        const outputArgs = [
              "-c:v", "libx264", "-pix_fmt", "yuv420p",
              "-preset", "slow", "-crf", "18", "-r", data.fps,
              '-movflags', '+faststart',
            ]
        debug && outputArgs.push("-report");

        const command = spawn("ffmpeg", [
          "-y",
          ...inputArgs,
          ...outputArgs,
          path.join(outDir, `${filename}.${format}`),
        ]);

        // get stdin from ffmpeg
        ({ stdin, stdout, stderr } = command);

        // stdin.on("data", (data) => {
        //   console.log(`${gray(`stdin`)}: ${data}`);
        // });
        stdout.on("data", (data) => {
          console.log(`${yellow(`stdout`)}: ${data}`);
        });
        stderr.on("data", (data) => {
          console.error(`${yellow("stderr")}: ${data}`);
        });

        isFfmpegReady = true;

        const msg = `${prefix()} streaming (${format}) started`;
        log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
        console.log(msg);
      } else if (format === "png") {
        // construct input and output args for ffmpeg
        const inputArgs =
          `-f image2pipe -framerate ${data.fps} -c:v png -i - -filter crop=${newWidth}:${newHeight}:0:0`.split(
            " ",
          );
        debug && inputArgs.push("-report");

        // create subDir for sequence export
        subDir = path.join(outDir, filename);
        if (!fs.existsSync(subDir)) {
          console.log(
            `${prefix()} creating a new directory at ${path.resolve(
              path.join(subDir),
            )}`,
          );
          fs.mkdirSync(subDir);
        }

        // spawn ffmpeg process
        const command = spawn("ffmpeg", [
          "-y",
          ...inputArgs,
          path.join(subDir, `%0${padLength}d.${format}`),
        ]);

        ({ stdin, stdout, stderr } = command);

        // stdin.on("data", (data) => {
        //   console.log(`${gray(`stdin`)}: ${data}`);
        // });
        stdout.on("data", (data) => {
          console.log(`${yellow(`stdout`)}: ${data}`);
        });
        stderr.on("data", (data) => {
          console.error(`${yellow("stderr")}: ${data}`);
        });

        isFfmpegReady = true;

        const msg = `${prefix()} streaming (${format}) started`;
        log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
        console.log(msg);
      }
    });

    server.ws.on("ssam:ffmpeg-newframe", async (data, client) => {
      if (!isFfmpegInstalled || !isFfmpegReady) return;

      // record a new frame

      // write frame and when it's written, ask for next frame
      const buffer = Buffer.from(data.image.split(",")[1], "base64");

      // 1. promise
      try {
        // FIX: when exporting large/long video (4k 60fps),
        // after about 15 seconds stdin.write() never gets called
        // when logged, buffer is received correctly,
        // can go into writePromise, but it never gets inside stdin.write()
        // - is it because stdin is overwhelmed by incoming data?

        await writePromise(stdin, buffer);

        // request next frame
        client.send("ssam:ffmpeg-reqframe");
        framesRecorded++;

        // send log to client
        const msg = `${prefix()} recording (${format}) frame... ${framesRecorded} of ${
          totalFrames ? totalFrames : "Infinity"
        }`;
        log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
        console.log(msg);
      } catch (e) {
        console.error(e);
      }
    });

    server.ws.on("ssam:ffmpeg-done", (_, client) => {
      if (!isFfmpegInstalled || !isFfmpegReady) return;

      // finish up recording
      stdin.end();

      // reset state
      isFfmpegReady = false;
      framesRecorded = 0;

      // send log to client
      let msg = "";
      if (format === "mp4") {
        msg = `${prefix()} ${path.join(
          outDir,
          `${filename}.${format}`,
        )} recording (${format}) complete`;
      } else if (format === "png") {
        msg = `${prefix()} ${path.join(
          subDir,
          `${"*".repeat(padLength)}.${format}`,
        )} recording (${format}) complete`;
      }
      log && client.send("ssam:log", { msg: removeAnsiEscapeCodes(msg) });
      console.log(msg);
      if (cropped) {
        log &&
          client.send("ssam:warn", { msg: removeAnsiEscapeCodes(msgCropped) });
        console.warn(msgCropped);
      }
    });
  },
});

const execPromise = (cmd: string) =>
  new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        reject(stderr);
      }
      resolve(stdout);
    });
  });

const writePromise = (stdin: Writable, buffer: Buffer) =>
  new Promise(async (resolve, reject) => {
    // console.log("in writePromise");

    stdin.write(buffer, (error) => {
      // console.log("in stdin.write");
      if (error) reject(error);
      else resolve(buffer);
    });
  });
