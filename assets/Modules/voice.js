/**
 * SMTinel Vault — Voice Module
 * Operational English Speech Synthesis
 * 
 * Features:
 * - Auto-detects best available voice (Microsoft Aria, Jenny, Guy, Ryan, Davis)
 * - Fallback chain for cross-browser compatibility
 * - iOS Safari optimized (user interaction required)
 * - Text chunking for long phrases
 * - Configurable rate/pitch/volume with localStorage persistence
 * - No external APIs, no backend, no API keys
 */

const VoiceModule = (function() {
  'use strict';

  // ===== CONFIGURATION =====
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
    'Microsoft Michelle Online (Natural)',
    'Microsoft Steffan Online (Natural)',
    'Microsoft Roger Online (Natural)',
    'Microsoft Ana Online (Natural)',
    'Jenny',
    'Guy',
    'Aria',
    'Ryan',
    'Davis',
    'Sonia',
    'Emma',
    'Brian'
  ];

  const FALLBACK_LOCAL_VOICES = [
    'Samantha', 'Alex', 'Fred', 'Victoria', 'Daniel', 'Karen', 'Moira', 'Tessa',
    'Google US English', 'Google UK English Female', 'Google UK English Male'
  ];

  const STORAGE_KEY = 'smtinel-voice-settings';
  const CHUNK_SIZE = 180; // Max chars per utterance to avoid truncation

  // ===== STATE =====
  let voices = [];
  let preferredVoice = null;
  let isSpeaking = false;
  let isPaused = false;
  let currentUtterances = [];
  let settings = {
    rate: 0.9,
    pitch: 1.0,
    volume: 1.0,
    voiceName: null
  };

  // ===== INITIALIZATION =====
  function init() {
    loadSettings();
    loadVoices();

    // iOS Safari: voices may need user interaction first
    // Chrome: voices load async via voiceschanged
    if ('speechSynthesis' in window) {
      if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = () => {
          voices = speechSynthesis.getVoices();
          selectPreferredVoice();
        };
      }
      // Immediate attempt (works on Firefox/Safari Desktop)
      setTimeout(() => {
        if (voices.length === 0) {
          voices = speechSynthesis.getVoices();
          selectPreferredVoice();
        }
      }, 100);
    }
  }

  // ===== VOICE LOADING =====
  function loadVoices() {
    if (!('speechSynthesis' in window)) return;
    voices = speechSynthesis.getVoices() || [];
    selectPreferredVoice();
  }

  function selectPreferredVoice() {
    if (voices.length === 0) return;

    // Try user-saved voice first
    if (settings.voiceName) {
      const saved = voices.find(v => v.name === settings.voiceName);
      if (saved) {
        preferredVoice = saved;
        return;
      }
    }

    // Try preferred natural voices
    for (const name of PREFERRED_VOICES) {
      const found = voices.find(v => v.name.includes(name));
      if (found) {
        preferredVoice = found;
        settings.voiceName = found.name;
        saveSettings();
        return;
      }
    }

    // Try fallback local voices
    for (const name of FALLBACK_LOCAL_VOICES) {
      const found = voices.find(v => v.name.includes(name));
      if (found) {
        preferredVoice = found;
        settings.voiceName = found.name;
        saveSettings();
        return;
      }
    }

    // Last resort: any English voice
    const english = voices.find(v => v.lang && v.lang.startsWith('en'));
    if (english) {
      preferredVoice = english;
      settings.voiceName = english.name;
      saveSettings();
      return;
    }

    // Ultimate fallback: first available voice
    preferredVoice = voices[0];
    settings.voiceName = voices[0].name;
    saveSettings();
  }

  // ===== TEXT CHUNKING =====
  function chunkText(text) {
    if (text.length <= CHUNK_SIZE) return [text];

    const chunks = [];
    let remaining = text;

    while (remaining.length > CHUNK_SIZE) {
      // Find best break point: sentence end > comma > space
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

    // Cancel any ongoing speech
    stopSpeech();

    // iOS Safari requires user interaction - we assume speak() is called from click handler
    const chunks = chunkText(text.trim());
    currentUtterances = [];
    isSpeaking = true;
    isPaused = false;

    // Update UI indicator
    updateSpeakingIndicator(true);

    chunks.forEach((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);

      // Apply settings
      utterance.rate = Math.max(0.5, Math.min(2, settings.rate));
      utterance.pitch = Math.max(0, Math.max(2, settings.pitch));
      utterance.volume = Math.max(0, Math.min(1, settings.volume));
      utterance.lang = 'en-US';

      // Apply voice (critical for iOS Safari)
      if (preferredVoice) {
        utterance.voice = preferredVoice;
        utterance.voiceURI = preferredVoice.voiceURI;
      }

      // Event handlers
      utterance.onstart = () => {
        isSpeaking = true;
        updateSpeakingIndicator(true);
      };

      utterance.onend = () => {
        if (index === chunks.length - 1) {
          isSpeaking = false;
          updateSpeakingIndicator(false);
        }
      };

      utterance.onerror = (e) => {
        console.warn('Speech error:', e.error);
        if (index === chunks.length - 1) {
          isSpeaking = false;
          updateSpeakingIndicator(false);
        }
      };

      utterance.onpause = () => { isPaused = true; };
      utterance.onresume = () => { isPaused = false; };

      currentUtterances.push(utterance);
      speechSynthesis.speak(utterance);
    });
  }

  // ===== CONTROL FUNCTIONS =====
  function stopSpeech() {
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
    }
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
  function setRate(rate) {
    settings.rate = Math.max(0.85, Math.min(1.0, parseFloat(rate)));
    saveSettings();
  }

  function setPitch(pitch) {
    settings.pitch = Math.max(0.8, Math.min(1.2, parseFloat(pitch)));
    saveSettings();
  }

  function setVolume(vol) {
    settings.volume = Math.max(0.5, Math.min(1.0, parseFloat(vol)));
    saveSettings();
  }

  function setVoiceByName(name) {
    const found = voices.find(v => v.name === name);
    if (found) {
      preferredVoice = found;
      settings.voiceName = name;
      saveSettings();
      return true;
    }
    return false;
  }

  function getAvailableVoices() {
    return voices.filter(v => v.lang && v.lang.startsWith('en')).map(v => ({
      name: v.name,
      lang: v.lang,
      local: v.localService,
      default: v.default
    }));
  }

  function getCurrentSettings() {
    return { ...settings };
  }

  // ===== PERSISTENCE =====
  function loadSettings() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        settings = { ...settings, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load voice settings:', e);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('Failed to save voice settings:', e);
    }
  }

  // ===== UI INDICATOR =====
  function updateSpeakingIndicator(active) {
    const indicator = document.getElementById('voice-indicator');
    if (indicator) {
      indicator.classList.toggle('speaking', active);
      indicator.textContent = active ? 'Speaking…' : 'Ready';
    }
  }

  // ===== PUBLIC API =====
  return {
    init,
    speak,
    stop: stopSpeech,
    pause: pauseSpeech,
    resume: resumeSpeech,
    loadVoices,
    setRate,
    setPitch,
    setVolume,
    setVoiceByName,
    getAvailableVoices,
    getCurrentSettings,
    get isSpeaking() { return isSpeaking; },
    get isPaused() { return isPaused; }
  };
})();

// Auto-init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  VoiceModule.init();
});

// Expose globally for onclick handlers
window.VoiceModule = VoiceModule;
