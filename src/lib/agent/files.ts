/**
 * What the agent may read on this machine, and images for the model. Server-only.
 *
 * File tools are read-only and confined to a root (a picked folder, or the
 * home folder for instructions). Inside the home folder, places that hold
 * credentials or private app data are refused, whatever the instruction.
 */

import os from "node:os";
import path from "node:path";

const DENIED_DIRS = [
  ".ssh", ".aws", ".gnupg", ".gpg", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh",
  ".password-store", ".netrc", "Library", ".Trash", ".mlch",
];
/** Under the denied Library folder: synced document folders (iCloud Drive, Dropbox, Google Drive…), which hold the person's own files. */
const ALLOWED_IN_DENIED = ["Library/Mobile Documents", "Library/CloudStorage"];
const DENIED_FILES = /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|keychain-db|kdbx))$/i;

/** The private folders under the home folder, as absolute paths. */
export function privateDirs(): string[] {
  // Run-time paths in the home folder; nothing for the bundler to trace.
  return DENIED_DIRS.map((dir) => path.join(/*turbopackIgnore: true*/ os.homedir(), dir));
}

/** Absolute path for `relative` inside `root`, or undefined if it escapes or is private. */
export function resolveReadable(root: string, relative: string): string | undefined {
  const cleaned = relative.replace(/^~\//, "").replace(/^\/+/, "");
  // An absolute path is allowed when it is inside the root.
  const target = path.isAbsolute(relative) && !relative.startsWith("~") ? path.resolve(relative) : path.resolve(root, cleaned);
  if (target !== root && !target.startsWith(root + path.sep)) return undefined;
  const home = os.homedir();
  const fromHome = target.startsWith(home + path.sep) ? target.slice(home.length + 1) : undefined;
  const allowed = fromHome && ALLOWED_IN_DENIED.some((dir) => fromHome === dir || fromHome.startsWith(dir + "/"));
  if (fromHome && !allowed && DENIED_DIRS.some((dir) => fromHome === dir || fromHome.startsWith(dir + "/"))) return undefined;
  if (DENIED_FILES.test(target)) return undefined;
  return target;
}

/** Whether a directory entry should be hidden from listings. */
export function hiddenEntry(fullPath: string): boolean {
  return resolveReadable(path.dirname(fullPath), path.basename(fullPath)) === undefined;
}

const MAX_IMAGE_SIDE = 1568;

/** An image as the model sees it: downscaled, PNG or JPEG, base64. */
export async function imageForModel(bytes: Buffer): Promise<{ data: string; mimeType: string }> {
  const sharp = (await import("sharp")).default;
  const image = sharp(bytes, { failOn: "none" }).rotate();
  const meta = await image.metadata();
  const resized = (meta.width ?? 0) > MAX_IMAGE_SIDE || (meta.height ?? 0) > MAX_IMAGE_SIDE ? image.resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, { fit: "inside" }) : image;
  const out = meta.hasAlpha ? await resized.png().toBuffer() : await resized.jpeg({ quality: 85 }).toBuffer();
  return { data: out.toString("base64"), mimeType: meta.hasAlpha ? "image/png" : "image/jpeg" };
}
