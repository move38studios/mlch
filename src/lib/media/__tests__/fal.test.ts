// @vitest-environment node
import { describe, expect, it } from "vitest";
import { outputFiles } from "../fal";
import { mediaClass } from "../inspect";

describe("outputFiles", () => {
  it("finds files in fal's usual result shapes", () => {
    expect(
      outputFiles({
        images: [{ url: "https://v3.fal.media/a.png", content_type: "image/png", width: 1 }],
        video: { url: "https://v3.fal.media/b.mp4" },
        audio_file: { url: "https://v3.fal.media/c.mp3", file_name: "c.mp3" },
        seed: 3,
        nested: { model_mesh: { url: "https://v3.fal.media/d.glb" } },
        not_a_file: { url: "http://insecure/x.png" },
      }).map((f) => f.url),
    ).toEqual(["https://v3.fal.media/a.png", "https://v3.fal.media/b.mp4", "https://v3.fal.media/c.mp3", "https://v3.fal.media/d.glb"]);
  });
});

describe("mediaClass", () => {
  it("classifies by mime, then extension", () => {
    expect(mediaClass("video/mp4")).toBe("video");
    expect(mediaClass(undefined, "x.glb")).toBe("model");
    expect(mediaClass("audio/mpeg")).toBe("audio");
    expect(mediaClass(undefined, "x.webp")).toBe("image");
  });
});
