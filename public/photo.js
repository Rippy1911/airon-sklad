// Photo form: collect up to four photos over several picks, shrink each to a JPEG the model reads well (long edge
// 1568 px), and submit them with the ordinary form. Without this script the form still works with the raw files.
(() => {
  const form = document.getElementById("photo-form");
  const input = document.getElementById("photos");
  const list = document.getElementById("previews");
  const status = document.getElementById("photo-status");
  if (
    !form || !input || !list || typeof DataTransfer === "undefined" ||
    typeof createImageBitmap === "undefined"
  ) return;

  const MAX = 4;
  const EDGE = 1568;
  const LIMIT = 3.5 * 1024 * 1024;
  const label = form.querySelector(".drop b");
  const button = form.querySelector('button[type="submit"]');
  const picked = [];
  form.classList.add("js");
  input.required = false;

  async function shrink(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, EDGE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.86));
    if (!blob) throw new Error("encode");
    return new File([blob], (file.name || "zdjecie").replace(/\.[^.]+$/, "") + ".jpg", {
      type: "image/jpeg",
    });
  }

  function sync() {
    const dt = new DataTransfer();
    for (const f of picked) dt.items.add(f);
    input.files = dt.files;
    if (label) {
      label.textContent = picked.length ? `Dodaj kolejne zdjęcie (${picked.length}/${MAX})` : "Dodaj zdjęcia";
    }
    list.replaceChildren(...picked.map((f, i) => {
      const li = document.createElement("li");
      const img = document.createElement("img");
      img.src = URL.createObjectURL(f);
      img.alt = `Zdjęcie ${i + 1}`;
      img.onload = () => URL.revokeObjectURL(img.src);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "Usuń";
      rm.setAttribute("aria-label", `Usuń zdjęcie ${i + 1}`);
      rm.addEventListener("click", () => {
        picked.splice(i, 1);
        sync();
      });
      li.append(img, rm);
      return li;
    }));
  }

  input.addEventListener("change", async () => {
    const fresh = [...input.files].filter((f) => !picked.includes(f));
    const room = MAX - picked.length;
    if (fresh.length > room) status.textContent = `Najwyżej ${MAX} zdjęcia. Dodaliśmy pierwsze ${room}.`;
    else status.textContent = "Przygotowuję zdjęcia…";
    for (const f of fresh.slice(0, Math.max(0, room))) {
      try {
        picked.push(await shrink(f));
      } catch {
        if (f.size <= LIMIT && /^image\/(jpeg|png|webp)$/.test(f.type)) picked.push(f);
        else status.textContent = "Nie udało się wczytać jednego ze zdjęć. Spróbuj JPEG albo PNG.";
      }
    }
    if (status.textContent === "Przygotowuję zdjęcia…") status.textContent = "";
    sync();
  });

  form.addEventListener("submit", (e) => {
    if (!picked.length) {
      e.preventDefault();
      status.textContent = "Dodaj co najmniej jedno zdjęcie.";
      return;
    }
    button.disabled = true;
    status.textContent = "Odczytuję skład. To trwa kilka sekund…";
  });
})();
