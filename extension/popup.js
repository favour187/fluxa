import { tabDraft, webTarget, handoffLink } from './links.mjs';

const api = globalThis.browser ?? globalThis.chrome;
const titleNode = document.querySelector('#tab-title');
const urlNode = document.querySelector('#tab-url');
const statusNode = document.querySelector('#status');
const target = document.querySelector('#target');
const webSettings = document.querySelector('#web-settings');
const webAddress = document.querySelector('#fluxa-url');
const send = document.querySelector('#send');
let draft = null;

const status = (message, error = false) => {
  statusNode.textContent = message;
  statusNode.classList.toggle('error', error);
};
const updateTarget = () => {
  webSettings.hidden = target.value !== 'web';
  send.disabled = !draft || (target.value === 'web' && !webTarget(webAddress.value));
};

async function init() {
  try {
    const saved = await api.storage.local.get({ target: 'web', webAddress: 'http://127.0.0.1:8787/' });
    target.value = saved.target === 'desktop' ? 'desktop' : 'web';
    webAddress.value = saved.webAddress;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    draft = tabDraft(tab?.url, tab?.title);
    if (!draft) {
      titleNode.textContent = 'This tab cannot be sent';
      status('Open a normal HTTP(S) page without embedded credentials, then try again.', true);
    } else {
      titleNode.textContent = draft.title;
      urlNode.textContent = draft.url;
    }
  } catch {
    status('Could not read the active tab. Try opening the extension while the tab is selected.', true);
  }
  updateTarget();
}

target.addEventListener('change', () => { updateTarget(); void api.storage.local.set({ target: target.value }); });
webAddress.addEventListener('input', updateTarget);
webAddress.addEventListener('change', () => { void api.storage.local.set({ webAddress: webAddress.value.trim() }); });
send.addEventListener('click', () => {
  try {
    if (!draft) return;
    const link = handoffLink(target.value, webAddress.value.trim(), draft);
    void api.storage.local.set({ target: target.value, webAddress: webAddress.value.trim() });
    // This happens only after an explicit click. An installed desktop app may
    // trigger the browser's external-protocol confirmation. If unavailable,
    // switch to web mode; never silently submit a tab to a background service.
    void api.tabs.create({ url: link }).then(() => window.close()).catch(() => {
      status('Could not open Fluxa. For desktop, install/register the app; otherwise select Fluxa web.', true);
    });
  } catch (error) { status(error.message, true); }
});

void init();
