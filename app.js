
import { FFmpeg } from
  "https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js";

import {
  fetchFile,
  toBlobURL
} from "https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js";

const $ = id => document.getElementById(id);

const videoInput = $("videoFiles");
const musicInput = $("musicFile");
const sfxInput = $("sfxFiles");
const clipList = $("clipList");
const statusEl = $("status");
const progressEl = $("progress");
const preview = $("preview");

let clips = [];
let locked = false;
let ffmpeg = null;
let renderedBlob = null;
let previewUrl = null;
let busy = false;
let logBuffer = [];
let durationByName = new Map();

function setStatus(message) {
  statusEl.textContent = message;
}

function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clearRenderedOutput() {
  renderedBlob = null;
  $("downloadButton").disabled = true;
  preview.hidden = true;

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  preview.removeAttribute("src");
}

function renderClipList() {
  clipList.replaceChildren();

  clips.forEach((clip, index) => {
    const item = document.createElement("div");
    item.className = "clip";

    const number = document.createElement("div");
    number.className = "number";
    number.textContent = String(index + 1).padStart(2, "0");

    const details = document.createElement("div");
    details.className = "clip-name";

    const name = document.createElement("div");
    name.textContent = clip.file.name;

    const meta = document.createElement("div");
    meta.className = "muted";
    meta.textContent =
      `${fmtTime(clip.duration)} · ${clip.width}×${clip.height} · ${formatBytes(clip.file.size)}`;

    details.append(name, meta);

    const buttons = document.createElement("div");
    buttons.className = "clip-buttons";

    const up = document.createElement("button");
    up.textContent = "↑";
    up.title = "เลื่อนขึ้น";
    up.disabled = locked || index === 0;
    up.onclick = () => moveClip(index, index - 1);

    const down = document.createElement("button");
    down.textContent = "↓";
    down.title = "เลื่อนลง";
    down.disabled = locked || index === clips.length - 1;
    down.onclick = () => moveClip(index, index + 1);

    const remove = document.createElement("button");
    remove.textContent = "ลบ";
    remove.className = "danger";
    remove.disabled = locked;
    remove.onclick = () => {
      clips.splice(index, 1);
      clearRenderedOutput();
      renderClipList();
    };

    buttons.append(up, down, remove);
    item.append(number, details, buttons);
    clipList.append(item);
  });

  $("lockButton").disabled = locked || clips.length === 0;
  $("unlockButton").disabled = !locked;
  $("orderStatus").textContent = locked
    ? `ล็อกแล้ว: ${clips.length} คลิป — ห้ามเปลี่ยนลำดับ`
    : `มี ${clips.length} คลิป — จัดลำดับก่อนล็อก`;
}

function moveClip(from, to) {
  if (locked || to < 0 || to >= clips.length) return;

  const [clip] = clips.splice(from, 1);
  clips.splice(to, 0, clip);

  clearRenderedOutput();
  renderClipList();
}

function readVideoMetadata(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");

    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const result = {
        file,
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight
      };
      URL.revokeObjectURL(url);
      resolve(result);
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`อ่านข้อมูลวิดีโอไม่ได้: ${file.name}`));
    };

    video.src = url;
  });
}

videoInput.addEventListener("change", async () => {
  if (locked) {
    alert("ต้องปลดล็อกลำดับก่อนเพิ่มคลิป");
    videoInput.value = "";
    return;
  }

  clearRenderedOutput();

  try {
    const files = Array.from(videoInput.files || []);
    for (const file of files) {
      const meta = await readVideoMetadata(file);
      clips.push(meta);
    }
    renderClipList();
  } catch (error) {
    alert(error.message);
  }

  videoInput.value = "";
});

$("lockButton").onclick = () => {
  if (!clips.length) return;
  locked = true;
  renderClipList();
};

$("unlockButton").onclick = () => {
  locked = false;
  clearRenderedOutput();
  renderClipList();
};

async function loadFFmpeg() {
  if (ffmpeg) return;

  setStatus("กำลังโหลด FFmpeg — ต้องเชื่อมต่ออินเทอร์เน็ตในครั้งแรก...");
  ffmpeg = new FFmpeg();

  ffmpeg.on("log", ({ message }) => {
    logBuffer.push(message);
    if (logBuffer.length > 3000) logBuffer.shift();
  });

  ffmpeg.on("progress", ({ progress }) => {
    progressEl.value = Math.max(
      0,
      Math.min(100, Math.round(progress * 100))
    );
  });

  const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";

  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm")
  });
}

async function writeInput(file, filename) {
  await ffmpeg.writeFile(filename, await fetchFile(file));
  return filename;
}

async function getSilenceIntervals(filename, threshold) {
  logBuffer = [];

  try {
    await ffmpeg.exec([
      "-hide_banner",
      "-i", filename,
      "-af", `silencedetect=noise=${threshold}dB:d=1.2`,
      "-f", "null",
      "-"
    ]);
  } catch {
    // FFmpeg อาจรายงานสถานะพิเศษระหว่างการตรวจจับเสียง
  }

  const textLog = logBuffer.join("\n");
  const starts = [...textLog.matchAll(/silence_start:\s*([0-9.]+)/g)]
    .map(m => Number(m[1]));
  const ends = [...textLog.matchAll(/silence_end:\s*([0-9.]+)/g)]
    .map(m => Number(m[1]));

  const intervals = [];

  starts.forEach((start, i) => {
    const end = ends[i] ?? null;
    if (end !== null && end > start) {
      intervals.push([start, end]);
    }
  });

  return intervals;
}

function buildKeepSegments(duration, silenceIntervals, enabled) {
  if (!enabled || !silenceIntervals.length) {
    return [[0, duration]];
  }

  const remove = silenceIntervals
    .filter(([start, end]) => end - start >= 1.2)
    // เว้นขอบไว้เล็กน้อยเพื่อไม่ตัดติดเสียงพูดเกินไป
    .map(([start, end]) => [
      Math.max(0, start + 0.10),
      Math.min(duration, end - 0.10)
    ])
    .filter(([start, end]) => end > start);

  if (!remove.length) return [[0, duration]];

  const keep = [];
  let cursor = 0;

  for (const [start, end] of remove) {
    if (start > cursor) keep.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }

  if (cursor < duration) keep.push([cursor, duration]);

  // ป้องกันการตัดทั้งคลิปเพราะเสียงเบามาก
  if (!keep.length) return [[0, duration]];

  return keep.filter(([start, end]) => end - start >= 0.15);
}

function escapeFilterPath(value) {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

async function probeDimensions(filename) {
  logBuffer = [];

  try {
    await ffmpeg.exec(["-hide_banner", "-i", filename]);
  } catch {
    // -i โดยไม่มี output มักจบด้วย error หลังแสดงข้อมูลไฟล์
  }

  const output = logBuffer.join("\n");
  const match = output.match(/Video:.*?(\d{2,5})x(\d{2,5})/s);

  if (!match) {
    throw new Error("อ่านความละเอียดของคลิปแรกไม่ได้");
  }

  return {
    width: Number(match[1]),
    height: Number(match[2])
  };
}

async function renderVideo() {
  if (busy) return;

  if (!locked) {
    alert("กรุณาจัดลำดับคลิปและล็อกลำดับก่อน");
    return;
  }

  if (!clips.length) {
    alert("กรุณาเพิ่มคลิปวิดีโอก่อน");
    return;
  }

  busy = true;
  $("renderButton").disabled = true;
  $("downloadButton").disabled = true;
  clearRenderedOutput();
  progressEl.value = 0;

  try {
    await loadFFmpeg();

    const inputNames = [];
    const keepByClip = [];
    const durations = [];
    durationByName = new Map();

    // อ่านไฟล์เข้าหน่วยความจำตามลำดับที่ล็อกไว้
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const filename = `clip_${String(i).padStart(3, "0")}.mp4`;

      setStatus(`กำลังเตรียมคลิป ${i + 1}/${clips.length}: ${clip.file.name}`);

      await writeInput(clip.file, filename);
      inputNames.push(filename);
      durationByName.set(filename, clip.duration);

      let silences = [];

      if ($("trimSilence").checked) {
        setStatus(`กำลังตรวจจับช่วงเงียบ ${i + 1}/${clips.length}...`);
        silences = await getSilenceIntervals(
          filename,
          $("silenceThreshold").value
        );
      }

      const keep = buildKeepSegments(
        clip.duration,
        silences,
        $("trimSilence").checked
      );

      keepByClip.push(keep);

      const keptDuration = keep.reduce(
        (sum, [start, end]) => sum + end - start,
        0
      );
      durations.push(keptDuration);
    }

    const totalDuration = durations.reduce((a, b) => a + b, 0);
    const target = $("targetDuration").value;

    if (target !== "auto" && totalDuration > Number(target) + 30) {
      setStatus(
        `คำเตือน: หลังตัดช่วงเงียบแล้วยังยาวประมาณ ${fmtTime(totalDuration)} ` +
        `ซึ่งเกินเป้าหมาย ${fmtTime(Number(target))} ` +
        "ระบบจะไม่ตัดเหตุการณ์สำคัญหรือเปลี่ยนลำดับเพื่อบังคับเวลา"
      );
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // ใช้ความละเอียดของคลิปแรกเป็นเกณฑ์
    const { width, height } = await probeDimensions(inputNames[0]);

    const musicFile = musicInput.files?.[0] || null;
    const sfxFiles = Array.from(sfxInput.files || []);

    let musicIndex = -1;
    const sfxIndexes = [];

    const args = ["-hide_banner", "-y"];

    for (const filename of inputNames) {
      args.push("-i", filename);
    }

    if (musicFile) {
      const musicName = "background_music";
      await writeInput(musicFile, musicName);

      musicIndex = inputNames.length;
      args.push("-stream_loop", "-1", "-i", musicName);
    }

    for (let i = 0; i < sfxFiles.length; i++) {
      const name = `sfx_${i}.audio`;
      await writeInput(sfxFiles[i], name);
      sfxIndexes.push(inputNames.length + (musicFile ? 1 : 0) + i);
      args.push("-i", name);
    }

    const graph = [];
    const videoLabels = [];
    const audioLabels = [];

    // ตัดแต่ละคลิปตามช่วงที่เก็บไว้ และต่อกลับตามลำดับเดิม
    for (let i = 0; i < inputNames.length; i++) {
      const segments = keepByClip[i];
      const vLabels = [];
      const aLabels = [];

      segments.forEach(([start, end], j) => {
        const v = `v_${i}_${j}`;
        const a = `a_${i}_${j}`;

        graph.push(
          `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
          `trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},` +
          `setpts=PTS-STARTPTS[${v}]`
        );

        graph.push(
          `[${i}:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},` +
          `asetpts=PTS-STARTPTS[${a}]`
        );

        vLabels.push(`[${v}]`);
        aLabels.push(`[${a}]`);
      });

      if (segments.length === 1) {
        videoLabels.push(vLabels[0]);
        audioLabels.push(aLabels[0]);
      } else {
        const vOut = `vc_${i}`;
        const aOut = `ac_${i}`;

        graph.push(
          `${vLabels.join("")}${aLabels.join("")}` +
          `concat=n=${segments.length}:v=1:a=1[${vOut}][${aOut}]`
        );

        videoLabels.push(`[${vOut}]`);
        audioLabels.push(`[${aOut}]`);
      }
    }

    graph.push(
      `${videoLabels.join("")}${audioLabels.join("")}` +
      `concat=n=${clips.length}:v=1:a=1[basev][basea]`
    );

    let audioOutput = "basea";

    // ลดเสียงเพลงเมื่อมีเสียงจากฟุตเทจหลัก
    if (musicFile) {
      if ($("duckMusic").checked) {
        graph.push(
          `[${musicIndex}:a]volume=${$("musicVolume").value}[music]`
        );
        graph.push(
          `[music][basea]sidechaincompress=` +
          `threshold=0.03:ratio=8:attack=20:release=300[ducked]`
        );
        graph.push(
          `[basea][ducked]amix=inputs=2:duration=first:` +
          `dropout_transition=2[a_music]`
        );
      } else {
        graph.push(
          `[${musicIndex}:a]volume=${$("musicVolume").value}[music]`
        );
        graph.push(
          `[basea][music]amix=inputs=2:duration=first:` +
          `dropout_transition=2[a_music]`
        );
      }

      audioOutput = "a_music";
    }

    // วาง SFX ตามลำดับไฟล์ที่เลือกไว้ ณ รอยต่อคลิป
    const sfxLabels = [];
    let boundaryTime = 0;

    for (let i = 0; i < sfxIndexes.length; i++) {
      const inputIndex = sfxIndexes[i];
      const boundaryIndex = Math.min(i, durations.length - 2);

      if (boundaryIndex < 0) break;

      boundaryTime = durations
        .slice(0, boundaryIndex + 1)
        .reduce((sum, value) => sum + value, 0);

      const label = `sfxmix_${i}`;
      const delayMs = Math.round(boundaryTime * 1000);

      graph.push(
        `[${inputIndex}:a]volume=${$("sfxVolume").value},` +
        `adelay=${delayMs}|${delayMs}[${label}]`
      );

      sfxLabels.push(`[${label}]`);
    }

    if (sfxLabels.length) {
      graph.push(
        `[${audioOutput}]${sfxLabels.join("")}` +
        `amix=inputs=${sfxLabels.length + 1}:duration=first:` +
        `dropout_transition=2[a_final]`
      );
      audioOutput = "a_final";
    }

    args.push(
      "-filter_complex", graph.join(";"),
      "-map", "[basev]",
      "-map", `[${audioOutput}]`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "20",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      "-t", String(totalDuration),
      "rough_cut_v2.mp4"
    );

    setStatus(
      `กำลังสร้างวิดีโอร่าง ความละเอียดอ้างอิง ${width}×${height} ` +
      `ความยาวประมาณ ${fmtTime(totalDuration)}...`
    );

    await ffmpeg.exec(args);

    const outputData = await ffmpeg.readFile("rough_cut_v2.mp4");
    renderedBlob = new Blob([outputData], { type: "video/mp4" });
    previewUrl = URL.createObjectURL(renderedBlob);

    preview.src = previewUrl;
    preview.hidden = false;
    $("downloadButton").disabled = false;

    setStatus(
      `สร้างวิดีโอร่างเสร็จแล้ว\n` +
      `ความละเอียดอ้างอิง: ${width}×${height}\n` +
      `ความยาวโดยประมาณ: ${fmtTime(totalDuration)}\n` +
      `ขนาดไฟล์: ${formatBytes(renderedBlob.size)}\n\n` +
      "กรุณาตรวจสอบภาพ เสียง และจุดตัดในตัวเล่นก่อนดาวน์โหลด"
    );
    progressEl.value = 100;

  } catch (error) {
    console.error(error);
    setStatus(
      "เกิดข้อผิดพลาดในการประมวลผล\n" +
      (error?.message || String(error)) +
      "\nลองลดจำนวนคลิปหรือประมวลผลคลิปที่สั้นลงก่อน"
    );
  } finally {
    busy = false;
    $("renderButton").disabled = false;
  }
}

$("renderButton").onclick = renderVideo;

$("downloadButton").onclick = () => {
  if (!renderedBlob) return;

  const link = document.createElement("a");
  const url = URL.createObjectURL(renderedBlob);

  link.href = url;
  link.download = "Auto_Rough_Cut_V2.mp4";
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 30000);
};

renderClipList();
