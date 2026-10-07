/** Files macOS Quick Look can preview that the canvas otherwise shows as text (see the thumbnail route). Shared by browser and server. */
export const THUMBNAIL_EXTENSIONS = new Set(["pptx", "ppt", "key", "docx", "doc", "pages", "xlsx", "xls", "numbers", "pdf", "rtf"]);

export function hasThumbnail(fileName: string | undefined): boolean {
  return !!fileName && THUMBNAIL_EXTENSIONS.has(fileName.split(".").pop()?.toLowerCase() ?? "");
}
