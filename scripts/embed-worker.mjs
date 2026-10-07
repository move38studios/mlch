// Local text embeddings in a worker thread of the Mulch server.
//
// Pure JavaScript and WebAssembly, no native code: the native ONNX runtime
// crashes inside Electron (EXC_BREAKPOINT in V8). The tokenizer comes from
// transformers.js's web build (its Node build loads the native runtime on
// import); the model runs in onnxruntime-web. Model: multilingual-e5-small,
// quantised, downloaded once into ~/.mulch/models.
//
// Protocol: { id, texts, role } -> { id, vectors: Float32Array[] } | { id, error }.
import { parentPort } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODEL = "Xenova/multilingual-e5-small";
const FILES = ["onnx/model_quantized.onnx", "tokenizer.json", "tokenizer_config.json"];
const modelDir = path.join(os.homedir(), ".mulch", "models", MODEL);

let ready;

/** The model's files, downloaded once. */
async function download() {
  for (const name of FILES) {
    const file = path.join(modelDir, name);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const response = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${name}`);
    if (!response.ok) throw new Error(`Model download failed (${response.status}): ${name}`);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(temporary, file);
  }
}

async function load() {
  ready ??= (async () => {
    await download();
    const transformers = await import(new URL("../node_modules/@huggingface/transformers/dist/transformers.web.js", import.meta.url).href);
    const read = (name) => JSON.parse(fs.readFileSync(path.join(modelDir, name), "utf8"));
    const config = read("tokenizer_config.json");
    const Tokenizer = transformers[config.tokenizer_class] ?? transformers.PreTrainedTokenizer;
    const tokenizer = new Tokenizer(read("tokenizer.json"), config);
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = Math.min(4, Math.max(1, os.availableParallelism() - 2));
    const session = await ort.InferenceSession.create(fs.readFileSync(path.join(modelDir, FILES[0])));
    return { tokenizer, session, ort };
  })();
  return ready;
}

async function embed(texts, role) {
  const { tokenizer, session, ort } = await load();
  // Plain arrays: the web build's own tensors need its runtime set up.
  const encoded = tokenizer(texts.map((t) => `${role}: ${String(t).slice(0, 2000)}`), { padding: true, truncation: true, max_length: 512, return_tensor: false });
  const batchSize = encoded.input_ids.length;
  const length = encoded.input_ids[0].length;
  const tensor = (rows) => new ort.Tensor("int64", BigInt64Array.from(rows.flat().map(BigInt)), [batchSize, length]);
  const flatMask = encoded.attention_mask.flat();
  const feeds = {};
  for (const name of session.inputNames) {
    feeds[name] = name === "input_ids" ? tensor(encoded.input_ids) : name === "attention_mask" ? tensor(encoded.attention_mask) : tensor(encoded.input_ids.map((row) => row.map(() => 0)));
  }
  const output = await session.run(feeds);
  const hidden = output[session.outputNames[0]];
  const [batch, tokens, dims] = hidden.dims;
  const mask = flatMask;
  // Mean over real tokens, then unit length.
  return Array.from({ length: batch }, (_, i) => {
    const vector = new Float32Array(dims);
    let count = 0;
    for (let j = 0; j < tokens; j++) {
      if (!mask[i * tokens + j]) continue;
      count++;
      const base = (i * tokens + j) * dims;
      for (let k = 0; k < dims; k++) vector[k] += hidden.data[base + k];
    }
    let norm = 0;
    for (let k = 0; k < dims; k++) {
      vector[k] /= count || 1;
      norm += vector[k] * vector[k];
    }
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < dims; k++) vector[k] /= norm;
    return vector;
  });
}

parentPort.on("message", async ({ id, texts, role }) => {
  try {
    parentPort.postMessage({ id, vectors: await embed(texts, role) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.stack ?? error) });
  }
});
