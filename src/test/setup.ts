import "@testing-library/jest-dom/vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tests log to a temp folder, never the user's ~/Library/Logs/mulch.
process.env.MULCH_LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mulch-test-logs-"));
