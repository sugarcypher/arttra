const $ = (sel) => document.querySelector(sel);

let config = null;
let adminPassword = "";
let unlocked = false;
let selectedFiles = [];

function setStatus(msg, kind = "info") {
  const box = $("#statusBox");
  box.hidden = false;
  box.textContent = msg;
  if (kind === "error") box.classList.add("statusBox--error");
  else box.classList.remove("statusBox--error");
}

function clearStatus() {
  const box = $("#statusBox");
  box.hidden = true;
  box.classList.remove("statusBox--error");
  box.textContent = "";
}

function stripExtension(name) {
  return name.replace(/\.[^/.]+$/, "");
}

function renderPreviews(files) {
  const strip = $("#previewStrip");
  strip.innerHTML = "";

  for (const f of files) {
    const card = document.createElement("div");
    card.className = "previewThumb";

    const img = document.createElement("img");
    img.alt = f.name;
    card.appendChild(img);

    const reader = new FileReader();
    reader.onload = () => {
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(f);

    strip.appendChild(card);
  }
}

async function loadJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return await res.json();
}

async function init() {
  config = await loadJSON("./data/config.json");

  const authBtn = $("#authBtn");
  const adminPasswordInput = $("#adminPasswordInput");
  const authView = $("#authView");
  const uploadView = $("#uploadView");
  const chooseFilesBtn = $("#chooseFilesBtn");
  const fileInput = $("#fileInput");
  const uploadBtn = $("#uploadBtn");
  const clearBtn = $("#clearBtn");
  const uploadZone = $(".uploadZone");

  const previewStrip = $("#previewStrip");

  const progressLine = $("#progressLine");
  const progressBar = $("#progressBar");

  const startingPriceInput = $("#startingPriceInput");
  const skuPrefixInput = $("#skuPrefixInput");
  const styleInput = $("#styleInput");
  const moodInput = $("#moodInput");
  const useFilenameTitleInput = $("#useFilenameTitle");

  function setUnlocked(v) {
    unlocked = v;
    authView.hidden = v;
    uploadView.hidden = !v;
  }

  authBtn.addEventListener("click", () => {
    const pw = String(adminPasswordInput.value || "");
    if (!pw.trim()) {
      setStatus("Enter the upload password.", "error");
      return;
    }
    adminPassword = pw;
    clearStatus();
    setUnlocked(true);
    setStatus("Unlocked. Select images to upload.", "info");
  });

  function setSelected(files) {
    selectedFiles = Array.from(files || []).filter((f) => f && String(f.type || "").startsWith("image/"));
    renderPreviews(selectedFiles);
    clearStatus();
  }

  chooseFilesBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => setSelected(e.target.files));
  clearBtn.addEventListener("click", () => {
    selectedFiles = [];
    fileInput.value = "";
    previewStrip.innerHTML = "";
    progressLine.hidden = true;
    progressBar.style.width = "0%";
    clearStatus();
  });

  uploadZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  uploadZone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (files && files.length) setSelected(files);
  });

  uploadBtn.addEventListener("click", async () => {
    if (!unlocked) {
      setStatus("Unlock upload first.", "error");
      return;
    }
    if (!selectedFiles.length) {
      setStatus("Choose at least one image.", "error");
      return;
    }

    const uploadUrl = config?.admin?.uploadUrl || "";
    const pwHeader = config?.admin?.passwordHeader || "x-admin-password";

    if (!uploadUrl || uploadUrl.includes("YOUR_CLOUD_FUNCTION_URL")) {
      setStatus("Upload endpoint is not configured. Edit data/config.json.", "error");
      return;
    }

    clearStatus();
    progressLine.hidden = false;

    const total = selectedFiles.length;
    for (let i = 0; i < total; i++) {
      const file = selectedFiles[i];
      const pct = Math.round(((i) / total) * 100);
      progressBar.style.width = `${pct}%`;
      setStatus(`Uploading ${i + 1}/${total}: ${file.name}`);

      const fd = new FormData();
      fd.append("file", file, file.name);

      fd.append("startingPrice", String(startingPriceInput.value || ""));
      fd.append("skuPrefix", String(skuPrefixInput.value || ""));
      fd.append("style", String(styleInput.value || ""));
      fd.append("mood", String(moodInput.value || ""));
      fd.append("useFilenameAsTitle", String(Boolean(useFilenameTitleInput.checked)));

      // Optional: title explicitly (backend can ignore if useFilenameAsTitle=true).
      fd.append("title", stripExtension(file.name));

      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          [pwHeader]: adminPassword,
        },
        body: fd,
      });

      if (!res.ok) {
        let details = "";
        try {
          const j = await res.json();
          details = j?.error ? ` ${j.error}` : "";
        } catch {
          // ignore
        }
        progressBar.style.width = "0%";
        setStatus(`Upload failed (${res.status}).${details}`, "error");
        return;
      }

      progressBar.style.width = `${Math.round(((i + 1) / total) * 100)}%`;
    }

    setStatus("Upload complete. Refreshing gallery...");
    window.location.href = `./?t=${Date.now()}`;
  });

  // Initial state
  setStatus("Locked. Enter your upload password to unlock.", "info");
}

init().catch((e) => {
  // If config missing, keep UI visible with a helpful error.
  const box = $("#statusBox");
  if (box) {
    box.hidden = false;
    box.classList.add("statusBox--error");
    box.textContent = String(e?.message || e || "Admin page failed to load config.");
  }
});

