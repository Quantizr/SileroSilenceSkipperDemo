//Browser console voice activity detection script. Paste all the following code into your browser console. (Chromium based only for now)


(async function main() {
  console.log("--- STARTING VAD SCRIPT ---");

  // =================================================================
  // 1. ASSET FETCHING (CORS BYPASS)
  // =================================================================
  
  let policy;
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      policy = window.trustedTypes.createPolicy('vad-policy-v28', {
        createScriptURL: (s) => s,
        createScript: (s) => s,
      });
    } catch (e) { console.warn("Policy exists..."); }
  }

  async function fetchToBlobUrl(url, mime) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${url}`);
    const blob = await resp.blob();
    return URL.createObjectURL(new Blob([blob], { type: mime }));
  }

  const wasmBlob = await fetchToBlobUrl("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort-wasm.wasm", "application/wasm");
  const modelBlob = await fetchToBlobUrl("https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad.onnx", "application/octet-stream");

  if (typeof ort === 'undefined') {
    const ortUrl = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.14.0/dist/ort.min.js";
    const resp = await fetch(ortUrl);
    const text = await resp.text();
    const script = document.createElement('script');
    script.textContent = policy ? policy.createScript(text) : text;
    document.head.appendChild(script);
  }

  await new Promise(r => setTimeout(r, 200));

  window.ort.env.wasm.numThreads = 1; 
  window.ort.env.wasm.proxy = false;   
  window.ort.env.wasm.simd = false;    
  window.ort.env.wasm.wasmPaths = { 'ort-wasm.wasm': wasmBlob };


  // =================================================================
  // 2. LOGIC & VARIABLES
  // =================================================================

  // --- DEFAULTS ---
  window.playbackFast = 4.0;
  window.playbackSlow = 2.0; 
  window.positiveSpeechThreshold = 0.5;
  window.negativeSpeechThreshold = 0.3; 
  window.noSpeakingSampleThreshold = 2;

  let playbackSpeed = 1.0;
  let video = document.querySelector('video');
  let audioCtx = new (window.AudioContext || window.webkitAudioContext)(); 
  let source;
  let processor;
  let session = null;
  
  let noSpeakingSamples = 0;
  let desyncCounter = 0;
  let vadStarted = false;
  let fastTime = null;
  let timeSaved = 0;

  // GRAPH
  const probabilityHistory = new Array(100).fill(0);
  let canvasCtx = null;
  let canvasElement = null;

  // V6 CONSTANTS
  const WINDOW_SIZE = 512;
  const CONTEXT_SIZE = 64; 
  let stateTensor = new window.ort.Tensor('float32', new Float32Array(2 * 1 * 128).fill(0), [2, 1, 128]);
  let contextBuffer = new Float32Array(CONTEXT_SIZE).fill(0);
  const srTensor = new window.ort.Tensor('int64', new BigInt64Array([16000n]), [1]);

  // =================================================================
  // 3. GRAPHING LOGIC
  // =================================================================

  function updateGraph(currentProb) {
    if (!canvasCtx || !canvasElement) return;

    probabilityHistory.push(currentProb);
    probabilityHistory.shift();

    const width = canvasElement.width;
    const height = canvasElement.height;

    // Clear
    canvasCtx.fillStyle = '#f0f0f0';
    canvasCtx.fillRect(0, 0, width, height);

    // Draw Thresholds
    // Upper (Green)
    const upperY = height - (window.positiveSpeechThreshold * height);
    canvasCtx.beginPath();
    canvasCtx.strokeStyle = 'rgba(0, 150, 0, 0.6)';
    canvasCtx.lineWidth = 1;
    canvasCtx.setLineDash([5, 3]);
    canvasCtx.moveTo(0, upperY);
    canvasCtx.lineTo(width, upperY);
    canvasCtx.stroke();

    // Lower (Red)
    const lowerY = height - (window.negativeSpeechThreshold * height);
    canvasCtx.beginPath();
    canvasCtx.strokeStyle = 'rgba(200, 0, 0, 0.6)';
    canvasCtx.lineWidth = 1;
    canvasCtx.setLineDash([5, 3]);
    canvasCtx.moveTo(0, lowerY);
    canvasCtx.lineTo(width, lowerY);
    canvasCtx.stroke();

    // Draw Line
    canvasCtx.beginPath();
    canvasCtx.strokeStyle = '#007bff';
    canvasCtx.lineWidth = 2;
    canvasCtx.setLineDash([]);
    const step = width / (probabilityHistory.length - 1);
    
    for (let i = 0; i < probabilityHistory.length; i++) {
        const val = probabilityHistory[i];
        const x = i * step;
        const y = height - (val * height);
        if (i === 0) canvasCtx.moveTo(x, y);
        else canvasCtx.lineTo(x, y);
    }
    canvasCtx.stroke();
  }

  // =================================================================
  // 4. MANUAL ENGINE
  // =================================================================

  async function startVAD() {
    if (vadStarted) return;
    
    if (!session) {
        session = await window.ort.InferenceSession.create(modelBlob, {
            executionProviders: ['wasm'],
            graphOptimizationLevel: 'all'
        });
    }

    if (!source && video) {
        try { source = audioCtx.createMediaElementSource(video); } catch(e) {}
    }

    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioCtx.destination);
    source.connect(audioCtx.destination); 

    let audioBuffer = [];

    processor.onaudioprocess = async (e) => {
        if (video.paused) return;

        const inputData = e.inputBuffer.getChannelData(0);
        let samples = inputData;

        if (audioCtx.sampleRate !== 16000) {
            const ratio = audioCtx.sampleRate / 16000;
            const newLength = Math.floor(inputData.length / ratio);
            samples = new Float32Array(newLength);
            for (let i = 0; i < newLength; i++) {
                samples[i] = inputData[Math.floor(i * ratio)];
            }
        }

        for (let s of samples) audioBuffer.push(s);

        while (audioBuffer.length >= WINDOW_SIZE) {
            const chunkRaw = new Float32Array(audioBuffer.slice(0, WINDOW_SIZE));
            audioBuffer = audioBuffer.slice(WINDOW_SIZE);

            const inputConcat = new Float32Array(CONTEXT_SIZE + WINDOW_SIZE);
            inputConcat.set(contextBuffer, 0);
            inputConcat.set(chunkRaw, CONTEXT_SIZE);

            const inputTensor = new window.ort.Tensor('float32', inputConcat, [1, CONTEXT_SIZE + WINDOW_SIZE]);

            try {
                const results = await session.run({ 
                    input: inputTensor, 
                    state: stateTensor, 
                    sr: srTensor 
                });

                stateTensor = results.stateN; 
                const probability = results.output.data[0]; 
                contextBuffer = chunkRaw.slice(WINDOW_SIZE - CONTEXT_SIZE);

                updateGraph(probability);

                const isSpeech = probability; 
                
                if (isSpeech > window.positiveSpeechThreshold) {
                    if (playbackSpeed != window.playbackSlow) {
                        playbackSpeed = window.playbackSlow;
                        video.playbackRate = playbackSpeed;
                        noSpeakingSamples = 0;
                        const currentTime = video.currentTime;
                        if (fastTime !== null) {
                            const timeDiff = Math.round((currentTime - fastTime)*1000);
                            timeSaved += Math.round(timeDiff*(window.playbackFast-1)/(window.playbackFast*window.playbackSlow));
                        }
                    } else {
                        if (noSpeakingSamples > 0) noSpeakingSamples--;
                    }
                }

                if (isSpeech < window.negativeSpeechThreshold && playbackSpeed != window.playbackFast) {
                    noSpeakingSamples++;
                    if (noSpeakingSamples >= window.noSpeakingSampleThreshold) {
                        playbackSpeed = window.playbackFast;
                        video.playbackRate = playbackSpeed;
                        desyncCounter++;
                        if (desyncCounter >= 10) {
                            video.currentTime = video.currentTime;
                            desyncCounter = 0;
                        }
                        fastTime = video.currentTime;
                    }
                }

                if (Math.abs(video.playbackRate - playbackSpeed) > 0.1) {
                    video.playbackRate = playbackSpeed;
                }

            } catch (err) {
                console.error("VAD Inference Error:", err);
            }
        }
    };
  }

  // =================================================================
  // 5. UI CONSTRUCTION
  // =================================================================

  startVAD().then(() => {
    vadStarted = true;
    if (video) {
      loadingIndicator.style.display = 'none';
      controlsContainer.style.display = 'block';
    }
  });

  video.addEventListener("play", function() {
    fastTime = null;
    if (!source) startVAD();
    noSpeakingSamples = -2; 
    audioCtx.resume();
  });
  video.addEventListener("pause", () => { fastTime = null; audioCtx.suspend(); });
  video.addEventListener("loadeddata", () => { fastTime = null; startVAD(); });

  // --- Main Container ---
  const overlayContainer = document.createElement('div');
  overlayContainer.style.position = 'fixed';
  overlayContainer.style.bottom = '10px';
  overlayContainer.style.right = '10px';
  overlayContainer.style.zIndex = '9999';
  overlayContainer.style.backgroundColor = 'rgba(255, 255, 255, 0.95)';
  overlayContainer.style.padding = '10px';
  overlayContainer.style.borderRadius = '5px';
  overlayContainer.style.boxShadow = '0 0 10px rgba(0, 0, 0, 0.3)';
  overlayContainer.style.width = '240px'; 
  overlayContainer.style.fontFamily = 'sans-serif';
  document.body.appendChild(overlayContainer);

  // --- Title Bar ---
  const titleContainer = document.createElement('div');
  titleContainer.style.display = 'flex';
  titleContainer.style.alignItems = 'center';
  titleContainer.style.justifyContent = 'space-between';
  titleContainer.style.cursor = 'move';
  titleContainer.style.marginBottom = '10px';
  titleContainer.style.borderBottom = '1px solid #ddd';
  titleContainer.style.paddingBottom = '5px';

  const title = document.createElement('div');
  title.textContent = 'VAD Settings';
  title.style.fontSize = '14px';
  title.style.fontWeight = 'bold';
  titleContainer.appendChild(title);

  const minimizeButton = document.createElement('button');
  minimizeButton.textContent = '-';
  minimizeButton.style.cursor = 'pointer';
  minimizeButton.style.marginLeft = '10px';
  minimizeButton.style.border = '1px solid #ccc';
  minimizeButton.style.background = '#fff';
  minimizeButton.style.borderRadius = '3px';
  minimizeButton.style.padding = '0px 6px';
  minimizeButton.addEventListener('click', toggleMinimize);
  titleContainer.appendChild(minimizeButton);

  overlayContainer.appendChild(titleContainer);

  const loadingIndicator = document.createElement('div');
  loadingIndicator.textContent = 'Loading AI Model...';
  loadingIndicator.style.fontSize = '12px';
  overlayContainer.appendChild(loadingIndicator);

  // --- Controls Wrapper ---
  const controlsContainer = document.createElement('div');
  controlsContainer.style.display = 'none';
  overlayContainer.appendChild(controlsContainer);

  // --- Graph ---
  const canvasContainer = document.createElement('div');
  canvasContainer.style.marginBottom = '10px';
  canvasContainer.style.border = '1px solid #ccc';
  canvasContainer.style.backgroundColor = '#f9f9f9';
  
  canvasElement = document.createElement('canvas');
  canvasElement.width = 220;
  canvasElement.height = 60;
  canvasElement.style.width = '100%'; 
  canvasElement.style.display = 'block';
  canvasCtx = canvasElement.getContext('2d');
  
  canvasContainer.appendChild(canvasElement);
  controlsContainer.appendChild(canvasContainer);

  // --- Sliders ---
  
  controlsContainer.appendChild(createSlider('Speech Speed', 0.5, 5.0, window.playbackSlow, 0.25, (s) => window.playbackSlow = s));
  controlsContainer.appendChild(createSlider('Skip Speed', 0.5, 5.0, window.playbackFast, 0.25, (s) => window.playbackFast = s));

  controlsContainer.appendChild(createSlider('Start Threshold', 0.0, 1.0, window.positiveSpeechThreshold, 0.05, (s) => window.positiveSpeechThreshold = s));
  controlsContainer.appendChild(createSlider('Stop Threshold', 0.0, 1.0, window.negativeSpeechThreshold, 0.05, (s) => window.negativeSpeechThreshold = s));


  // =================================================================
  // 6. UI HELPERS
  // =================================================================

  function toggleMinimize() {
    const isMinimized = controlsContainer.style.display === 'none';
    if (isMinimized) {
        controlsContainer.style.display = 'block';
        minimizeButton.textContent = '-';
        titleContainer.style.marginBottom = '10px';
        titleContainer.style.borderBottom = '1px solid #ddd';
        overlayContainer.style.paddingBottom = '10px';
    } else {
        controlsContainer.style.display = 'none';
        minimizeButton.textContent = '+';
        titleContainer.style.marginBottom = '0px';
        titleContainer.style.borderBottom = 'none';
        overlayContainer.style.paddingBottom = '5px';
    }
  }

  function createSlider(labelText, min, max, defaultValue, step, onChange) {
    const container = document.createElement('div');
    container.style.marginBottom = '8px';
    
    const labelRow = document.createElement('div');
    labelRow.style.display = 'flex';
    labelRow.style.justifyContent = 'space-between';
    
    const label = document.createElement('div');
    label.textContent = labelText;
    label.style.fontSize = '11px';
    label.style.color = '#444';
    
    const valueLabel = document.createElement('div');
    valueLabel.textContent = defaultValue.toFixed(2);
    valueLabel.style.fontSize = '11px';
    valueLabel.style.fontWeight = 'bold';

    labelRow.appendChild(label);
    labelRow.appendChild(valueLabel);
    container.appendChild(labelRow);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.step = step;
    slider.value = defaultValue; 
    slider.style.width = '100%';
    slider.style.margin = '2px 0';
    slider.style.cursor = 'pointer';

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      valueLabel.textContent = val.toFixed(2);
      onChange(val);
      if (video.paused && canvasCtx) updateGraph(probabilityHistory[probabilityHistory.length-1]);
    });
    
    container.appendChild(slider);
    return container;
  }

  // --- Drag Logic ---
  titleContainer.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', handleDrag);
  document.addEventListener('mouseup', endDrag);

  let isDragging = false;
  let offsetX, offsetY;

  function startDrag(e) {
    isDragging = true;
    offsetX = e.clientX - overlayContainer.getBoundingClientRect().left;
    offsetY = e.clientY - overlayContainer.getBoundingClientRect().top;
    e.preventDefault();
  }

  function handleDrag(e) {
    if (isDragging) {
      const x = e.clientX - offsetX;
      const y = e.clientY - offsetY;
      overlayContainer.style.left = `${x}px`;
      overlayContainer.style.top = `${y}px`;
      overlayContainer.style.bottom = 'auto';
      overlayContainer.style.right = 'auto';
    }
  }

  function endDrag() {
    isDragging = false;
    const rect = overlayContainer.getBoundingClientRect();
    const docHeight = document.documentElement.clientHeight;
    const docWidth = document.documentElement.clientWidth;

    if (rect.top < docHeight/2) {
      overlayContainer.style.top = `${rect.top}px`;
      overlayContainer.style.bottom = 'auto';
    } else {
      overlayContainer.style.top = 'auto';
      overlayContainer.style.bottom = `${docHeight - rect.bottom}px`;
    }

    if (rect.left < docWidth/2) {
      overlayContainer.style.left = `${rect.left}px`;
      overlayContainer.style.right = 'auto';
    } else {
      overlayContainer.style.left = 'auto';
      overlayContainer.style.right = `${docWidth - rect.right}px`;
    }
  }

})();
