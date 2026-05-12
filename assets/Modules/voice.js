/**
 * SMTinel Vault — Voice Module (v2)
 * iOS Safari + Chrome + Firefox compatible
 * 
 * iOS Safari Quirks:
 * - getVoices() returns empty until first user interaction
 * - voiceschanged may not fire automatically
 * - Must call getVoices() from within a click/touch handler
 */

const VoiceModule = (function() {
  'use strict';

  const PREFERRED_VOICES = [
    'Microsoft Aria Online (Natural)',
    'Microsoft Jenny Online (Natural)', 
    'Microsoft Guy Online (Natural)',
    'Microsoft Ryan Online (Natural)',
    'Microsoft Davis Online (Natural)',
    'Microsoft Sonia Online (Natural)',
    'Microsoft Emma Online (Natural)',
    'Microsoft Brian Online (Natural)',
    'Microsoft Christopher Online (Natural)',
    'Microsoft Steffan Online (Natural)',
    'Microsoft Roger Online (Natural)',
    'Microsoft Ana Online (Natural)',
    'Jenny','Guy','Aria','Ryan','Davis','Sonia','Emma','Brian'
  ];

  const FALLBACK_LOCAL = ['Samantha','Alex','Fred','Victoria','Daniel','Karen','Moira','Tessa',
    'Google US English','Google UK English Female','Google UK English Male'];

  const STORAGE_KEY = 'smtinel-voice-settings';
  const CHUNK_SIZE = 180;

  let voices = [];
  let preferredVoice = null;
  let isSpeaking = false;
  let isPaused = false;
  let currentUtterances = [];
  let voicesLoaded = false;
  let onReadyCallback = null;
  let loadAttempts = 0;
  const MAX_LOAD_ATTEMPTS = 5;

  let settings = { rate: 0.9, pitch: 1.0, volume: 1.0, voiceName: null };

  // ===== INIT =====
  function init(callback) {
    loadSettings();
    onReadyCallback = callback || null;

    if (!('speechSynthesis' in window)) {
      console.warn('TTS not supported');
      voicesLoaded = true;
      return;
    }

    // Strategy 1: Listen for voiceschanged event
    speechSynthesis.onvoiceschanged = function() {
      console.log('voiceschanged fired');
      voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        selectPreferredVoice();
        voicesLoaded = true;
        if (onReadyCallback) onReadyCallback();
      }
    };

    // Strategy 2: Immediate check (Firefox, Chrome desktop)
    tryLoadVoices();

    // Strategy 3: Retry with backoff
    const retryInterval = setInterval(function() {
      if (voicesLoaded || loadAttempts >= MAX_LOAD_ATTEMPTS) {
        clearInterval(retryInterval);
        return;
      }
      tryLoadVoices();
    }, 500);

    // Strategy 4: Force load on first user interaction (critical for iOS)
    document.addEventListener('click', function handler() {
      if (!voicesLoaded) {
        console.log('User interaction - forcing voice load');
        tryLoadVoices();
        setTimeout(tryLoadVoices, 100);
      }
      document.removeEventListener('click', handler);
    });

    document.addEventListener('touchstart', function handler() {
      if (!voicesLoaded) {
        console.log('Touch interaction - forcing voice load');
        tryLoadVoices();
        setTimeout(tryLoadVoices, 100);
      }
      document.removeEventListener('touchstart', handler);
    });
  }

  function tryLoadVoices() {
    if (!('speechSynthesis' in window)) return;
    loadAttempts++;

    try {
      // Cancel any pending speech to unlock voices on iOS
      speechSynthesis.cancel();

      const v = speechSynthesis.getVoices();
      if (v && v.length > 0) {
        console.log('Voices loaded:', v.length);
        voices = v;
        selectPreferredVoice();
        voicesLoaded = true;
        if (onReadyCallback) onReadyCallback();
      }
    } catch(e) {
      console.warn('Voice load attempt', loadAttempts, 'failed:', e);
    }
  }

  function forceLoadVoices() {
    loadAttempts = 0;
    tryLoadVoices();
    setTimeout(tryLoadVoices, 200);
    setTimeout(tryLoadVoices, 500);
  }

  // ===== VOICE SELECTION =====
  function selectPreferredVoice() {
    if (voices.length === 0) return;

    // Try saved voice
    if (settings.voiceName) {
      const saved = voices.find(v => v.name === settings.voiceName);
      if (saved) { preferredVoice = saved; return; }
    }

    // Try preferred list
    for (const name of PREFERRED_VOICES) {
      const found = voices.find(v => v.name.includes(name));
      if (found) { preferredVoice = found; settings.voiceName = found.name; saveSettings(); return; }
    }

    // Try fallback list
    for (const name of FALLBACK_LOCAL) {
      const found = voices.find(v => v.name.includes(name));
      if (found) { preferredVoice = found; settings.voiceName = found.name; saveSettings(); return; }
    }

    // Any English voice
    const english = voices.find(v => v.lang && v.lang.startsWith('en'));
    if (english) { preferredVoice = english; settings.voiceName = english.name; saveSettings(); return; }

    // Ultimate fallback
    preferredVoice = voices[0];
    settings.voiceName = voices[0].name;
    saveSettings();
  }

  // ===== CHUNKING =====
  function chunkText(text) {
    if (text.length <= CHUNK_SIZE) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > CHUNK_SIZE) {
      let breakAt = remaining.lastIndexOf('. ', CHUNK_SIZE);
      if (breakAt < CHUNK_SIZE * 0.5) breakAt = remaining.lastIndexOf('? ', CHUNK_SIZE);
      if (breakAt < CHUNK_SIZE * 0.5) breakAt = remaining.lastIndexOf('! ', CHUNK_SIZE);
      if (breakAt < CHUNK_SIZE * 0.5) breakAt = remaining.lastIndexOf(', ', CHUNK_SIZE);
      if (breakAt < CHUNK_SIZE * 0.5) breakAt = remaining.lastIndexOf(' ', CHUNK_SIZE);
      if (breakAt <= 0) breakAt = CHUNK_SIZE;
      chunks.push(remaining.substring(0, breakAt + 1).trim());
      remaining = remaining.substring(breakAt + 1).trim();
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }

  // ===== SPEAK =====
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    if (!text || text.trim().length === 0) return;

    // iOS: ensure voices are loaded from user interaction context
    if (!voicesLoaded) {
      tryLoadVoices();
    }

    stopSpeech();
    const chunks = chunkText(text.trim());
    currentUtterances = [];
    isSpeaking = true;
    isPaused = false;
    updateSpeakingIndicator(true);

    chunks.forEach(function(chunk, index) {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.rate = Math.max(0.5, Math.min(2, settings.rate));
      utterance.pitch = Math.max(0, Math.min(2, settings.pitch));
      utterance.volume = Math.max(0, Math.min(1, settings.volume));
      utterance.lang = 'en-US';

      if (preferredVoice) {
        utterance.voice = preferredVoice;
        utterance.voiceURI = preferredVoice.voiceURI;
      }

      utterance.onstart = function() {
        isSpeaking = true;
        updateSpeakingIndicator(true);
      };
      utterance.onend = function() {
        if (index === chunks.length - 1) {
          isSpeaking = false;
          updateSpeakingIndicator(false);
        }
      };
      utterance.onerror = function(e) {
        console.warn('Speech error:', e.error);
        if (index === chunks.length - 1) {
          isSpeaking = false;
          updateSpeakingIndicator(false);
        }
      };

      currentUtterances.push(utterance);
      speechSynthesis.speak(utterance);
    });
  }

  // ===== CONTROLS =====
  function stopSpeech() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    isSpeaking = false;
    isPaused = false;
    currentUtterances = [];
    updateSpeakingIndicator(false);
  }

  function pauseSpeech() {
    if ('speechSynthesis' in window && isSpeaking && !isPaused) {
      speechSynthesis.pause();
      isPaused = true;
    }
  }

  function resumeSpeech() {
    if ('speechSynthesis' in window && isPaused) {
      speechSynthesis.resume();
      isPaused = false;
    }
  }

  // ===== SETTINGS =====
  function setRate(rate) { settings.rate = Math.max(0.85, Math.min(1.0, parseFloat(rate))); saveSettings(); }
  function setPitch(pitch) { settings.pitch = Math.max(0.8, Math.min(1.2, parseFloat(pitch))); saveSettings(); }
  function setVolume(vol) { settings.volume = Math.max(0.5, Math.min(1.0, parseFloat(vol))); saveSettings(); }

  function setVoiceByName(name) {
    const found = voices.find(v => v.name === name);
    if (found) { preferredVoice = found; settings.voiceName = name; saveSettings(); return true; }
    return false;
  }

  function getAvailableVoices() {
    const english = voices.filter(v => v.lang && v.lang.startsWith('en'));
    const target = english.length > 0 ? english : voices;
    return target.map(v => ({ name: v.name, lang: v.lang, local: v.localService, default: v.default }));
  }

  function getCurrentSettings() { return { ...settings }; }

  // ===== PERSISTENCE =====
  function loadSettings() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) settings = { ...settings, ...JSON.parse(stored) };
    } catch(e) { console.warn('Failed to load voice settings:', e); }
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch(e) { console.warn('Failed to save voice settings:', e); }
  }

  // ===== UI =====
  function updateSpeakingIndicator(active) {
    const indicator = document.getElementById('voice-indicator');
    if (indicator) {
      indicator.classList.toggle('speaking', active);
      indicator.textContent = active ? 'Speaking…' : (voicesLoaded ? 'Ready' : 'Loading voices...');
    }
  }

  // ===== PUBLIC API =====
  return {
    init: init,
    speak: speak,
    stop: stopSpeech,
    pause: pauseSpeech,
    resume: resumeSpeech,
    loadVoices: tryLoadVoices,
    forceLoadVoices: forceLoadVoices,
    setRate: setRate,
    setPitch: setPitch,
    setVolume: setVolume,
    setVoiceByName: setVoiceByName,
    getAvailableVoices: getAvailableVoices,
    getCurrentSettings: getCurrentSettings,
    get isSpeaking() { return isSpeaking; },
    get isPaused() { return isPaused; },
    get voicesLoaded() { return voicesLoaded; }
  };
})();

window.VoiceModule = VoiceModule;
