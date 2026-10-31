/*
 * Wix ↔ HubSpot attribution capture.
 * Installed on the Wix site (Embedded Script extension, or Settings → Custom Code):
 *   <script src="https://<app-host>/utm.js" data-site-key="<key>" async></script>
 *
 * 1. Stores first-touch and latest UTM parameters, landing page and referrer (first-party localStorage).
 * 2. When a form containing an email field is submitted, sends that context to the app with
 *    navigator.sendBeacon. The server joins it to the Wix form submission by hashed email.
 * No cookies, no third-party storage, nothing sent until a visitor submits a form.
 */
(function () {
  var script = document.currentScript || document.querySelector('script[data-site-key]');
  if (!script) return;
  var siteKey = script.getAttribute('data-site-key');
  var endpoint = new URL('/api/public/attribution', script.src).toString();
  var KEYS = ['source', 'medium', 'campaign', 'term', 'content'];
  var STORE = 'whs_attr_v1';

  function read() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { return {}; }
  }
  function write(v) {
    try { localStorage.setItem(STORE, JSON.stringify(v)); } catch (e) {}
  }
  function externalReferrer() {
    try {
      return document.referrer && new URL(document.referrer).host !== location.host ? document.referrer : '';
    } catch (e) { return ''; }
  }

  var params = new URLSearchParams(location.search);
  var utm = {};
  var hasUtm = false;
  KEYS.forEach(function (k) {
    var v = params.get('utm_' + k);
    if (v) { utm[k] = v; hasUtm = true; }
  });

  var state = read();
  var now = new Date().toISOString();
  if (!state.firstTouch) {
    state.firstTouch = { utm: utm, landingPage: location.href, referrer: externalReferrer(), at: now };
  }
  if (hasUtm) {
    state.latest = { utm: utm, landingPage: location.href, referrer: externalReferrer(), at: now };
  } else if (!state.latest) {
    state.latest = state.firstTouch;
  }
  write(state);

  function findEmail(root) {
    var inputs = (root || document).querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var hint = (el.type + ' ' + el.name + ' ' + el.id + ' ' + (el.getAttribute('aria-label') || '') + ' ' + el.autocomplete).toLowerCase();
      if (hint.indexOf('email') !== -1 && /\S+@\S+\.\S+/.test(el.value)) return el.value.trim();
    }
    return null;
  }

  var lastSent = '';
  function send(root) {
    var email = findEmail(root);
    if (!email || !siteKey) return;
    var s = read();
    var payload = JSON.stringify({
      siteKey: siteKey,
      email: email,
      utm: (s.latest && s.latest.utm) || {},
      firstTouch: s.firstTouch,
      pageUrl: location.href,
      referrer: (s.latest && s.latest.referrer) || externalReferrer(),
      ts: new Date().toISOString()
    });
    if (payload === lastSent) return;
    lastSent = payload;
    if (navigator.sendBeacon) navigator.sendBeacon(endpoint, payload);
    else fetch(endpoint, { method: 'POST', body: payload, keepalive: true, mode: 'cors' });
  }

  // Native submit events (classic forms) …
  document.addEventListener('submit', function (e) { send(e.target); }, true);
  // … and Wix Forms, whose submit button doesn't always dispatch a native submit event.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('button, [role="button"], input[type="submit"]');
    if (!btn) return;
    var label = (btn.getAttribute('type') + ' ' + (btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
    if (label.indexOf('submit') !== -1 || label.indexOf('send') !== -1 || label.indexOf('sign up') !== -1 || label.indexOf('subscribe') !== -1) {
      send(btn.closest('form') || document);
    }
  }, true);
})();
