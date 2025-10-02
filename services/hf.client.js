// services/hf.client.js
const { HfInference } = require("@huggingface/inference");
const HF_API_KEY = process.env.HUGGINGFACE_API_KEY || "";

if (!HF_API_KEY) {
  console.warn("HUGGINGFACE_API_KEY not set. HF calls will fail.");
}
const hf = new HfInference(HF_API_KEY);

/**
 * generateText(prompt, options) => string
 * Uses a text-generation / chat model from HuggingFace inference.
 * Pick a reasonable free model on HF (e.g. "tiiuae/falcon-7b-instruct" or a smaller one)
 * Ensure model supports your token budget.
 */
async function generateText(prompt, { model = process.env.HF_GEN_MODEL || "google/flan-t5-large", max_new_tokens = 400 } = {}) {
  const modelName = model;
  const res = await hf.textGeneration({
    model: modelName,
    inputs: prompt,
    parameters: {
      max_new_tokens,
      do_sample: false,
      temperature: 0.2,
    },
  });
  // HF returns array or object; coerce to string safely
  if (!res) return "";
  if (Array.isArray(res)) return res[0].generated_text || (res[0].text || "");
  if (typeof res === "object") return res.generated_text || res.text || JSON.stringify(res);
  return String(res);
}

/**
 * embedTexts(texts[]) => [vectors]
 * Uses a sentence-transformers model via HF Inference Embeddings API.
 * Recommended free model: "sentence-transformers/all-MiniLM-L6-v2"
 */
async function embedTexts(texts, { model = process.env.HF_EMBED_MODEL || "sentence-transformers/all-MiniLM-L6-v2" } = {}) {
  if (!Array.isArray(texts)) texts = [texts];
  const resp = await hf.embeddings({ model, input: texts });
  // resp may be array of {embedding: []} or a single object depending on SDK
  if (Array.isArray(resp)) {
    return resp.map(r => r.embedding || r);
  } else if (resp && resp.embedding) {
    return [resp.embedding];
  } else {
    // fallback: try to coerce
    return resp;
  }
}

module.exports = {
  generateText,
  embedTexts,
};
