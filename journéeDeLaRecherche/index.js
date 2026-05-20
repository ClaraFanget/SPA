const FRAMES_PER_ARTWORK = 42;
const FALLBACK_SECONDS = 42;
const STATIC_DETECT_MS = 1000;
const WASM_DISPLAY_FPS = 60;

const artworkContainer = document.getElementById("artwork-container");
const artworkNameEl = document.getElementById("artwork-name");
const artistNameEl = document.getElementById("artist-name");
const artworkYearEl = document.getElementById("artwork-year");

const RUST_WASM_RUNTIME = "rust-wasm";

let presentationOrder = [];
let currentIndex = 0;
let artworkInstance = null;
let rustRuntimeState = null;
let timingState = null;
let isAdvancing = false;

function fisherYatesShuffle(array) {
    const result = array.slice();
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
}

function isRustWasmArtwork(artwork) {
    return artwork && artwork.runtime === RUST_WASM_RUNTIME;
}

function clearTiming() {
    if (!timingState) {
        return;
    }

    if (timingState.fallbackTimeoutId) {
        clearTimeout(timingState.fallbackTimeoutId);
    }

    if (timingState.checkIntervalId) {
        clearInterval(timingState.checkIntervalId);
    }

    if (timingState.checkRafId) {
        cancelAnimationFrame(timingState.checkRafId);
    }

    timingState = null;
}

function stopRustRuntime() {
    if (!rustRuntimeState) {
        return;
    }

    rustRuntimeState.cancelled = true;

    if (rustRuntimeState.frameId) {
        cancelAnimationFrame(rustRuntimeState.frameId);
    }

    if (rustRuntimeState.onResize) {
        window.removeEventListener("resize", rustRuntimeState.onResize);
    }

    if (rustRuntimeState.canvas && rustRuntimeState.canvas.parentNode) {
        rustRuntimeState.canvas.parentNode.removeChild(rustRuntimeState.canvas);
    }

    rustRuntimeState = null;
}

function stopP5Runtime() {
    if (artworkInstance) {
        artworkInstance.remove();
        artworkInstance = null;
    }
}

function removeCurrentScript() {
    const oldScript = document.getElementById("current-script");
    if (oldScript) {
        oldScript.remove();
    }
}

function stopCurrentArtwork() {
    clearTiming();
    stopRustRuntime();
    stopP5Runtime();
    removeCurrentScript();
}

function showError(message) {
    artworkContainer.innerHTML =
        '<div class="presentation-error">' + message + "</div>";
}

function scheduleFallbackAdvance() {
    clearTiming();
    timingState = {
        fallbackTimeoutId: setTimeout(() => {
            nextArtwork();
        }, FALLBACK_SECONDS * 1000),
    };
}

function scheduleAdvanceWhenReady(onReady) {
    clearTiming();
    timingState = {
        fallbackTimeoutId: setTimeout(() => {
            nextArtwork();
        }, FALLBACK_SECONDS * 1000),
        staticDetectTimeoutId: setTimeout(() => {
            if (timingState && !timingState.frameMonitorStarted) {
                timingState.usingStaticFallback = true;
            }
        }, STATIC_DETECT_MS),
    };

    onReady();
}

function startP5FrameMonitor() {
    if (!artworkInstance || !timingState) {
        return;
    }

    timingState.frameMonitorStarted = true;
    timingState.startFrame = artworkInstance.frameCount;
    timingState.lastSeenFrame = artworkInstance.frameCount;
    timingState.lastFrameChangeTime = performance.now();

    const checkFrames = () => {
        if (!artworkInstance || !timingState || isAdvancing) {
            return;
        }

        const currentFrame = artworkInstance.frameCount;
        if (currentFrame !== timingState.lastSeenFrame) {
            timingState.lastSeenFrame = currentFrame;
            timingState.lastFrameChangeTime = performance.now();
        }

        const fps = artworkInstance.frameRate() || 60;
        const targetFrames = FRAMES_PER_ARTWORK * fps;
        const elapsedFrames = currentFrame - timingState.startFrame;

        if (elapsedFrames >= targetFrames) {
            nextArtwork();
            return;
        }

        const stalledMs = performance.now() - timingState.lastFrameChangeTime;
        if (stalledMs >= STATIC_DETECT_MS && !timingState.usingStaticFallback) {
            timingState.usingStaticFallback = true;
        }

        timingState.checkRafId = requestAnimationFrame(checkFrames);
    };

    timingState.checkRafId = requestAnimationFrame(checkFrames);
}

function startWasmFrameMonitor(getFrameCount) {
    if (!timingState) {
        return;
    }

    timingState.frameMonitorStarted = true;
    timingState.targetFrames = FRAMES_PER_ARTWORK * WASM_DISPLAY_FPS;

    const checkFrames = () => {
        if (!timingState || isAdvancing || !rustRuntimeState) {
            return;
        }

        const frameCount = getFrameCount();
        if (frameCount >= timingState.targetFrames) {
            nextArtwork();
            return;
        }

        timingState.checkRafId = requestAnimationFrame(checkFrames);
    };

    timingState.checkRafId = requestAnimationFrame(checkFrames);
}

function updateMetadata(artwork) {
    artworkNameEl.textContent = artwork.name || "";
    artistNameEl.textContent = artwork.artist || "";
    artworkYearEl.textContent = artwork.year || "";
}

async function runRustWasmArtwork(artwork) {
    stopCurrentArtwork();
    artworkContainer.innerHTML = "";

    if (!artwork.module || !artwork.wasm) {
        showError("Rust Wasm artwork is missing module/wasm paths");
        scheduleFallbackAdvance();
        return;
    }

    const state = {
        cancelled: false,
        frameId: 0,
        canvas: null,
        onResize: null,
        renderCount: 0,
    };
    rustRuntimeState = state;

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    artworkContainer.appendChild(canvas);
    state.canvas = canvas;

    const ctx = canvas.getContext("2d", { alpha: true });

    const resizeCanvas = () => {
        const width = Math.max(1, artworkContainer.offsetWidth);
        const height = Math.max(1, artworkContainer.offsetHeight);

        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }

        return { width, height };
    };

    state.onResize = () => {
        resizeCanvas();
    };
    window.addEventListener("resize", state.onResize);

    let wasmModule;
    try {
        wasmModule = await import(artwork.module);
    } catch (error) {
        console.error("Failed to import Rust Wasm module:", error);
        showError("Failed to import Rust Wasm module");
        stopRustRuntime();
        scheduleFallbackAdvance();
        return;
    }

    const initWasm = wasmModule.default || wasmModule.init;
    if (typeof initWasm !== "function") {
        showError("Rust Wasm module has no init function");
        stopRustRuntime();
        scheduleFallbackAdvance();
        return;
    }

    try {
        await initWasm(artwork.wasm);
    } catch (error) {
        console.error("Failed to initialize Rust Wasm module:", error);
        showError("Failed to initialize Rust Wasm module");
        stopRustRuntime();
        scheduleFallbackAdvance();
        return;
    }

    const exportName = artwork.exportName || "render";
    const renderFn = wasmModule[exportName];
    if (typeof renderFn !== "function") {
        showError("Rust Wasm module is missing a render export");
        stopRustRuntime();
        scheduleFallbackAdvance();
        return;
    }

    scheduleAdvanceWhenReady(() => {
        startWasmFrameMonitor(() => state.renderCount);
    });

    const renderFrame = (timestampMs) => {
        if (state.cancelled) {
            return;
        }

        const { width, height } = resizeCanvas();
        const timeSeconds = timestampMs / 1000;

        let rgba;
        try {
            rgba = renderFn(width, height, timeSeconds);
        } catch (error) {
            console.error("Rust Wasm render failed:", error);
            stopRustRuntime();
            showError("Rust Wasm render failed");
            scheduleFallbackAdvance();
            return;
        }

        if (!rgba || rgba.length !== width * height * 4) {
            stopRustRuntime();
            showError("Rust Wasm render returned an unexpected buffer");
            scheduleFallbackAdvance();
            return;
        }

        const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imageData, 0, 0);

        state.renderCount++;
        state.frameId = requestAnimationFrame(renderFrame);
    };

    state.frameId = requestAnimationFrame(renderFrame);
}

function runP5Artwork(artwork) {
    return new Promise((resolve) => {
        stopCurrentArtwork();
        artworkContainer.innerHTML = "";

        const script = document.createElement("script");
        script.src = artwork.src;
        script.id = "current-script";

        script.onload = () => {
            if (typeof sketch !== "function") {
                showError("Artwork script did not define a sketch");
                scheduleFallbackAdvance();
                resolve();
                return;
            }

            scheduleAdvanceWhenReady(() => {
                artworkInstance = new p5(sketch, artworkContainer);
                startP5FrameMonitor();
            });

            resolve();
        };

        script.onerror = () => {
            console.error("Failed to load artwork script:", artwork.src);
            showError("Failed to load artwork");
            scheduleFallbackAdvance();
            resolve();
        };

        document.body.appendChild(script);
    });
}

async function showArtwork(artwork) {
    updateMetadata(artwork);

    if (isRustWasmArtwork(artwork)) {
        await runRustWasmArtwork(artwork);
        return;
    }

    await runP5Artwork(artwork);
}

async function goToArtwork(delta) {
    if (isAdvancing || presentationOrder.length === 0) {
        return;
    }

    isAdvancing = true;
    stopCurrentArtwork();

    const length = presentationOrder.length;
    currentIndex = (currentIndex + delta + length) % length;

    try {
        await showArtwork(presentationOrder[currentIndex]);
    } finally {
        isAdvancing = false;
    }
}

function nextArtwork() {
    goToArtwork(1);
}

function previousArtwork() {
    goToArtwork(-1);
}

async function initPresentation() {
    try {
        const response = await fetch("../journéeDeLaRecherche/artworks.json");
        const artworks = await response.json();

        if (!artworks.length) {
            showError("No artworks found");
            return;
        }

        presentationOrder = fisherYatesShuffle(artworks);
        currentIndex = 0;
        await showArtwork(presentationOrder[currentIndex]);
    } catch (error) {
        console.error("Failed to load artworks:", error);
        showError("Failed to load artworks");
    }
}

window.addEventListener("keydown", (event) => {
    if (event.code === "ArrowRight" || event.code === "Space") {
        event.preventDefault();
        nextArtwork();
    } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        previousArtwork();
    }
});

initPresentation();
