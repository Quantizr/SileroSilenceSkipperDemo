//Browser console voice activity detection script. Paste all the following code into your browser console. (Chromium based only for now)

//ADJUSTABLE DEFAULTS
let playbackFast = 5;
let playbackSlow = 2;
let positiveSpeechThreshold = 0.5;
let negativeSpeechThreshold = 0.5;
let noSpeakingSampleThreshold = 2;
//

let playbackSpeed = 1.0;

let video;

let audioCtx = new AudioContext({sampleRate: 44100}); //force sample rate so that frame sample time is consistent
let source;
let audioNodeVAD;
let noSpeakingSamples = 0;
let desyncCounter = 0;

let vadStarted = false;
let fastTime = null;
let timeSaved = 0;

function loadScript1() {
  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.js';
  document.head.appendChild(script);
  console.log("Script 1 loaded")
  script.addEventListener("load", loadScript2);
}

function loadScript2() {
  var script2 = document.createElement('script');
  script2.src = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web/dist/bundle.min.js';
  document.head.appendChild(script2);
  console.log("Script 2 loaded")
  script2.addEventListener("load", runVAD);
}

function runVAD(){
  video = document.querySelector('video');

  async function startVAD() {
    if (vadStarted) return;
    audioNodeVAD = await vad.AudioNodeVAD.new(audioCtx, {
      frameSamples: 512, //32ms @ 16KHz, sample rate is resampled to 16KHz
      positiveSpeechThreshold: 1, //prevent default threshold from loading
      negativeSpeechThreshold: 0, //prevent default threshold from loading
      onFrameProcessed: (probabilities) => {
        //console.log("Frame processed", probabilities, video.currentTime);
        if (probabilities.isSpeech > positiveSpeechThreshold) {
          if (playbackSpeed != playbackSlow) {
            playbackSpeed = playbackSlow;
            video.playbackRate = playbackSpeed;
            noSpeakingSamples = 0
            //noSpeakingSamples = Math.floor(-1*playbackFast);
            //video.currentTime -= (0.033*playbackFast);
            const currentTime = video.currentTime;
            if (fastTime !== null) {
              const timeDiff = Math.round((currentTime - fastTime)*1000);
              console.log(`Sped up video time: ${timeDiff}ms`);
              timeSaved += Math.round(timeDiff*(playbackFast-1)/(playbackFast*playbackSlow));
            }

            console.log("Speech started - slowing down - time saved ", timeSaved/1000);
          } else {
            if (noSpeakingSamples > 0) noSpeakingSamples--;
          }
        }

        if (probabilities.isSpeech < negativeSpeechThreshold && playbackSpeed != playbackFast) {
          noSpeakingSamples++;
          //if (noSpeakingSamples >= Math.round(noSpeakingSampleThreshold/playbackSlow)) { //dynamically adjust silence gap based on video speed
          if (noSpeakingSamples >= noSpeakingSampleThreshold) {
            playbackSpeed = playbackFast;
            video.playbackRate = playbackSpeed;
            console.log("End of speech - speeding up");
            desyncCounter++;
            if (desyncCounter >= 10) {
              video.currentTime = video.currentTime;// += 1e-9;
              desyncCounter = 0;
              console.log("Resync video/audio");
            }
            fastTime = video.currentTime;
          }
        }

        if (video.playbackRate != playbackSpeed) {
          console.log("FALLBACK: Set playback speed");
          video.playbackRate = playbackSpeed;
        }

      }
    });
  }

  function setupVAD() {
    if (vadStarted) {
      audioCtx.resume();
      source = new MediaStreamAudioSourceNode(audioCtx, {
        mediaStream: video.captureStream(),
      })
      const merger = audioCtx.createChannelMerger(1);
      source.connect(merger);
      audioNodeVAD.receive(merger);
    }
  }

  startVAD().then(() => {
    vadStarted = true;

    //adjust overlay
    loadingIndicator.style.display = 'none';
    speechSpeedSlider.style.display = 'block';
    skipSpeedSlider.style.display = 'block';


    if (!video.paused && !source) {
      setupVAD();
      audioNodeVAD.start();
    }
  });

  video.addEventListener("play", function() {
    fastTime = null;
    console.log("Play event");
    if (!source) { //is this even possible
      setupVAD();
    }
    noSpeakingSamples = -2; //delay at first
    audioNodeVAD.start();
  });

  video.addEventListener("pause", () => {
    fastTime = null;
    console.log("Pause event");
    audioNodeVAD.pause();
  });

  video.addEventListener("seeked", () => {
    fastTime = null;
    console.log("Seeked event");
  });

  video.addEventListener("loadeddata", () => {
    fastTime = null;
    console.log("LoadedData event");
    setupVAD();
  });

}

loadScript1()

//The following is code for the overlay
const overlayContainer = document.createElement('div');
overlayContainer.style.position = 'fixed';
overlayContainer.style.bottom = '10px';
overlayContainer.style.right = '10px';
overlayContainer.style.zIndex = '9999';
overlayContainer.style.backgroundColor = 'rgba(255, 255, 255, 0.5)';
overlayContainer.style.padding = '10px';
overlayContainer.style.borderRadius = '5px';
overlayContainer.style.boxShadow = '0 0 10px rgba(0, 0, 0, 0.3)';
document.body.appendChild(overlayContainer);

const titleContainer = document.createElement('div');
titleContainer.style.display = 'flex';
titleContainer.style.alignItems = 'center';
titleContainer.style.justifyContent = 'space-between';

titleContainer.style.cursor = 'move'; // Set cursor to indicate draggability

const title = document.createElement('div');
title.textContent = 'VAD Script Settings';
title.style.fontSize = '14px';
title.style.fontWeight = 'bold';
titleContainer.appendChild(title);

const minimizeButton = document.createElement('button');
minimizeButton.textContent = '-';
minimizeButton.style.cursor = 'pointer';
minimizeButton.style.marginLeft = '10px';
minimizeButton.addEventListener('click', toggleMinimize);
titleContainer.appendChild(minimizeButton);

overlayContainer.appendChild(titleContainer);

const loadingIndicator = document.createElement('div');
loadingIndicator.textContent = 'Loading VAD scripts...';
loadingIndicator.style.fontSize = '14px';
overlayContainer.appendChild(loadingIndicator);

const speechSpeedSlider = createSlider('Speech Speed', 1, 5, playbackSlow, 0.25, (speed) => s(speed));
speechSpeedSlider.style.display = 'none';
overlayContainer.appendChild(speechSpeedSlider);

const skipSpeedSlider = createSlider('Skip Speed', 1, 5, playbackFast, 0.25, (speed) => f(speed));
skipSpeedSlider.style.display = 'none';
overlayContainer.appendChild(skipSpeedSlider);

// Event listeners for dragging
titleContainer.addEventListener('mousedown', startDrag);
document.addEventListener('mousemove', handleDrag);
document.addEventListener('mouseup', endDrag);

// Variables to track drag state
let isDragging = false;
let offsetX, offsetY;

// Functions for dragging
function startDrag(e) {
  isDragging = true;
  offsetX = e.clientX - overlayContainer.getBoundingClientRect().left;
  offsetY = e.clientY - overlayContainer.getBoundingClientRect().top;
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

  //in order that minimize snaps to the correct side
  const top = overlayContainer.getBoundingClientRect().top;
  const left = overlayContainer.getBoundingClientRect().left;
  const bottom = document.documentElement.clientHeight - overlayContainer.getBoundingClientRect().bottom;
  const right = document.documentElement.clientWidth - overlayContainer.getBoundingClientRect().right;

  if (top < document.documentElement.clientHeight/2) {
    overlayContainer.style.top = `${top}px`;
    overlayContainer.style.bottom = 'auto';
  } else {
    overlayContainer.style.top = 'auto';
    overlayContainer.style.bottom = `${bottom}px`;
  }

  if (left < document.documentElement.clientWidth/2) {
    overlayContainer.style.left = `${left}px`;
    overlayContainer.style.right = 'auto';
  } else {
    overlayContainer.style.left = 'auto';
    overlayContainer.style.right = `${right}px`;
  }
}

function createSlider(labelText, min, max, defaultValue, step, onChange) {
  const sliderContainer = document.createElement('div');

  const labelContainer = document.createElement('div');
  labelContainer.style.display = 'flex';
  labelContainer.style.justifyContent = 'space-between';

  const label = document.createElement('div');
  label.textContent = labelText;
  label.style.fontSize = '14px';
  labelContainer.appendChild(label);

  const speedLabel = document.createElement('div');
  speedLabel.textContent = `${parseFloat(defaultValue).toFixed(2)}x`;
  speedLabel.style.fontSize = '14px';
  labelContainer.appendChild(speedLabel);

  sliderContainer.appendChild(labelContainer);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = min;
  slider.max = max;
  slider.value = defaultValue;
  slider.step = step;
  slider.style.width = '150px';
  slider.style.marginBottom = '5px';
  slider.addEventListener('input', () => {
    const speed = parseFloat(slider.value).toFixed(2);
    speedLabel.textContent = `${speed}x`;
    onChange(speed);
  });
  sliderContainer.appendChild(slider);

  return sliderContainer;
}

function toggleMinimize() {
  const sliders = Array.from(overlayContainer.children).slice(2); // Exclude title container and loading indicator
  const isMinimized = sliders[0].style.display === 'none';

  sliders.forEach(slider => {
    slider.style.display = isMinimized ? 'block' : 'none';
  });

  minimizeButton.textContent = isMinimized ? '-' : '+';
}

function s(ps) {
  playbackSlow = ps;
  fastTime = null;
}

function f(pf) {
  playbackFast = pf;
  fastTime = null;
}

//for websites where switching pages breaks the element video is pointing to, e.g. coursera
function resetVAD() { 
  video = document.querySelector('video');
  fastTime = null;

  audioCtx.resume();
  source = new MediaStreamAudioSourceNode(audioCtx, {
    mediaStream: video.captureStream(),
  })
  const merger = audioCtx.createChannelMerger(1);
  source.connect(merger);
  audioNodeVAD.receive(merger);
  audioNodeVAD.start();

  video.addEventListener("play", function() {
    fastTime = null;
    console.log("Play event");
    noSpeakingSamples = -2; //delay at first
    audioNodeVAD.start();
  });

  video.addEventListener("pause", () => {
    fastTime = null;
    console.log("Pause event");
    audioNodeVAD.pause();
  });

  video.addEventListener("seeked", () => {
    fastTime = null;
    console.log("Seeked event");
  });

  video.addEventListener("loadeddata", () => {
    fastTime = null;
    console.log("LoadedData event");
    setupVAD();
  });
}
