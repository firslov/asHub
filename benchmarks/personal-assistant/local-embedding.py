"""Offline dense experiment against a fixed synthetic corpus; never reads app data."""
import json
import hashlib
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
from time import perf_counter
import torch
from transformers import AutoModel, AutoTokenizer

runner = Path(__file__).with_name("recall-zh.mjs")
directory = Path(sys.argv[1]).resolve()
weights = directory / "model.safetensors"
with weights.open("rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
assert digest == (
    "354763b9b1357bc9c44f62c6be2276321081ed2567773608c0d0785b61d5a026"
), "Use the pinned public BGE weights from the documented download."
data = json.loads(subprocess.check_output(["node", runner, "--corpus"]))
torch.set_num_threads(4)
start = perf_counter()
tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
model = AutoModel.from_pretrained(directory, local_files_only=True, trust_remote_code=False, use_safetensors=True).eval()

@torch.inference_mode()
def embed(text):
    tokens = tokenizer(text, truncation=True, padding=True, max_length=512, return_tensors="pt")
    return torch.nn.functional.normalize(model(**tokens).last_hidden_state[:, 0], dim=-1)

documents = embed([p[1] for p in data["passages"]])
startup = dict(ms=round((perf_counter()-start)*1000,2), weights_bytes=weights.stat().st_size,
               dimension=documents.shape[-1], device="cpu", threads=4, machine=platform.machine())
prefix = "为这个句子生成表示以用于检索相关文章："
embed([prefix + data["queries"][0]])  # warm query execution
scores, times = [], []
for query in data["queries"]:
    measurements = []
    for _ in range(5):
        begin = perf_counter()
        result = (embed([prefix+query]) @ documents.T).flatten().tolist()
        measurements.append((perf_counter()-begin)*1000)
    scores.append(result)
    times.append(sorted(measurements)[2])
with tempfile.TemporaryDirectory() as temp:
    output = Path(temp)/"scores.json"
    output.write_text(json.dumps(dict(scores=scores, ms=times, startup=startup)))
    subprocess.run(["node", runner, output], check=True)
