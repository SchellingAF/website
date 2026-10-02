// The passkey prompt for /sign-in, and the one script on this site that sends a
// request. It sends two kinds, both to this site and never to the API: one for a
// challenge, and one with what the passkey signed. The server passes both on to
// the product and keeps the token that comes back; this script never sees it.
//
// A passkey prompt cannot run without script: navigator.credentials is the only
// way a page reaches a passkey. Everything else on the signed-in pages is a plain
// form.
//
// A passkey signs whatever challenge its prompt carries, so no prompt opens for a
// challenge that is not the product's challenge to connect with: a post's would get
// back the person's signature on a post they never wrote. src/sign-in-challenge.js
// says what one is, and this site's server holds the product's answer to it too.
//
// The same prompt asks the passkey for the secret sealing needs, the WebAuthn "prf"
// extension on a fixed input (content/sealed.md, section 1). A passkey that gives one
// gives the same 32 bytes on every device it syncs to, and the person's encryption key
// is made from them here and kept in this browser under the connection's own secret,
// which the server's answer to connecting carries. It is never sent anywhere. A passkey
// that gives none still connects; the key's own page then says sealing is not possible.

import { NOT_A_SIGN_IN_CHALLENGE, signInChallenge } from "/sign-in-challenge.js";
import { PRF_INPUT, keepKey, keepNoKey, keyFromPrf } from "/sealed-store.js";

(function () {
  "use strict";

  var root = document.getElementById("passkey");
  if (!root) return;
  var status = document.getElementById("passkey-status");
  var buttons = root.querySelectorAll("button");
  var confirmRow = document.getElementById("passkey-confirm-row");
  // The offer to make a key, under Connect, when Connect found no passkey this site knows.
  var none = document.getElementById("passkey-none");
  var noneWhy = document.getElementById("passkey-none-why");

  function say(text) {
    status.textContent = text;
    if (none) none.hidden = true;
  }

  function offerNewKey(why) {
    busy(false);
    status.textContent = "Nothing was changed.";
    if (!none) return say(why);
    noneWhy.textContent = why;
    none.hidden = false;
  }

  function busy(on) {
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on;
  }

  // The PRF input: the same for everybody, SHA-256 of the label, written out so it is
  // there before any click, since nothing may be awaited between a click and its prompt
  // and a hash worked out here would be (test/sealed.test.ts holds it to prfInput()).
  var prf = PRF_INPUT;

  if (!window.PublicKeyCredential || !navigator.credentials) {
    say("This browser cannot use a passkey. Try a current version of Safari, Chrome, Edge or Firefox.");
    busy(true);
    return;
  }

  function b64u(buffer) {
    var bytes = new Uint8Array(buffer);
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // The bytes a prompt signs, or no prompt at all. Every prompt below takes its
  // challenge from here, and nothing is awaited, so the prompt still opens inside
  // the click.
  function challengeBytes(ch) {
    var bytes = ch ? signInChallenge(ch.challenge) : null;
    if (!bytes) throw new Error(NOT_A_SIGN_IN_CHALLENGE);
    return bytes;
  }

  function post(path, payload) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
        var error = new Error(body.message || "Something went wrong. Try again.");
        if (typeof body.code === "string") error.code = body.code;
        throw error;
      }
        return body;
      });
    });
  }

  function challenge() {
    return post("/sign-in/challenge", {});
  }

  // A challenge fetched before the click, so the prompt opens inside the click
  // itself. Safari before macOS 14.4 and iOS 17.4 opens a passkey prompt only
  // from a click, and a request made in between can cost it the click. A
  // challenge lasts five minutes; one held longer than two is not used, and the
  // click fetches its own instead.
  var HELD_MS = 120000;
  var held = null;
  var warming = false;

  function fresh() {
    return held !== null && Date.now() - held.at < HELD_MS;
  }

  function warm() {
    if (warming) return;
    warming = true;
    challenge().then(
      function (c) { held = { challenge: c, at: Date.now() }; warming = false; },
      function () { warming = false; }
    );
  }

  function warmIfStale() {
    if (!fresh()) warm();
  }

  // Runs a prompt with a challenge: at once when a fresh one is held, while the
  // browser still counts the click, and otherwise after fetching one. Each
  // challenge is used once, and the next one is fetched straight away.
  function withChallenge(prompt) {
    var result;
    if (fresh()) {
      var c = held.challenge;
      held = null;
      try {
        result = Promise.resolve(prompt(c));
      } catch (error) {
        result = Promise.reject(error);
      }
    } else {
      held = null;
      result = challenge().then(prompt);
    }
    warm();
    return result;
  }

  warm();
  root.addEventListener("pointerover", warmIfStale);
  root.addEventListener("focusin", warmIfStale);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") warmIfStale();
  });

  function assertion(ch, allow) {
    var options = {
      challenge: challengeBytes(ch),
      rpId: ch.rp_id,
      userVerification: "required",
      timeout: 120000,
    };
    if (allow) options.allowCredentials = [{ type: "public-key", id: allow }];
    if (prf) options.extensions = { prf: { eval: { first: prf } } };
    return navigator.credentials.get({ publicKey: options });
  }

  /** The passkey's PRF output, when it gave one: 32 bytes, or null. */
  function prfOf(credential) {
    var results = typeof credential.getClientExtensionResults === "function" ? credential.getClientExtensionResults() : {};
    var first = results && results.prf && results.prf.results && results.prf.results.first;
    return first && first.byteLength === 32 ? first : null;
  }

  function answer(ch, credential) {
    return {
      challenge: ch.challenge,
      credential_id: b64u(credential.rawId),
      client_data_json: b64u(credential.response.clientDataJSON),
      authenticator_data: b64u(credential.response.authenticatorData),
      signature: b64u(credential.response.signature),
    };
  }

  function finish(payload, secret) {
    // The page that sent the person here, such as an app's request to connect, to
    // come back to afterwards. The server decides whether it is one it will go to.
    var next = new URLSearchParams(window.location.search).get("next");
    if (next) payload.next = next;
    return post("/sign-in", payload).then(function (body) {
      say("Connected.");
      // The encryption key, kept before the page goes on; a failure to keep it
      // costs sealing on this device, never the connection.
      var kept = Promise.resolve();
      if (typeof body.peer_id === "string" && typeof body.wrap === "string") {
        kept = secret
          ? keyFromPrf(secret, body.peer_id).then(function (pair) { return keepKey(body.peer_id, body.wrap, pair); })
          : keepNoKey(body.peer_id);
      }
      return kept.catch(function () {}).then(function () {
        window.location.assign(body.location || "/me");
      });
    });
  }

  // A passkey this device made that the service has not yet seen sign. It is
  // not a key until the service has, and confirming it again beats making
  // another passkey the service will never know.
  var made = null;

  function confirmMade(ch) {
    return assertion(ch, made.rawId).then(function (credential) {
      var payload = answer(ch, credential);
      payload.public_key = b64u(made.response.getPublicKey());
      payload.algorithm = made.response.getPublicKeyAlgorithm();
      return finish(payload, prfOf(credential));
    });
  }

  // A person pressing Cancel on the prompt is not an error worth a paragraph.
  function failed(error) {
    busy(false);
    if (made) {
      confirmRow.hidden = false;
      var why = error && error.name !== "NotAllowedError" && error.message ? error.message + " " : "";
      say(why + 'Your new passkey is made but not registered yet. Press "Confirm the new passkey" to finish.');
    } else if (error && error.name === "NotAllowedError") {
      say("The passkey prompt was closed before it finished. Nothing was changed.");
    } else if (error && error.name === "InvalidStateError") {
      say('This device already holds a passkey for this key. Use "Connect with a passkey" instead.');
    } else {
      say(error && error.message ? error.message : "Something went wrong. Try again.");
    }
  }

  // A browser does not say whether a prompt found no passkey or was closed: both are
  // NotAllowedError. Either way a person with no key here yet is offered one.
  function connectFailed(error) {
    if (error && error.code === "PASSKEY_NOT_REGISTERED") {
      offerNewKey("This passkey is not registered here, so it is not a key on this site. Make a new key instead: your device makes a passkey and asks you to confirm it twice.");
    } else if (error && error.name === "NotAllowedError") {
      offerNewKey("No passkey for this site was found on this device, or the prompt was closed. If you have no key here yet, make one now: your device makes a passkey and asks you to confirm it twice.");
    } else {
      failed(error);
    }
  }

  document.getElementById("passkey-sign-in").addEventListener("click", function () {
    busy(true);
    say("Waiting for your passkey.");
    withChallenge(function (ch) {
      return assertion(ch, null).then(function (credential) { return finish(answer(ch, credential), prfOf(credential)); });
    }).catch(connectFailed);
  });

  // Makes a key, from its own button or from the offer under Connect. The prompt opens
  // inside whichever click it was.
  function makeKey() {
    var named = document.getElementById("passkey-name").value.trim().slice(0, 64);
    var label = named || "Schelling Add Forward";
    made = null;
    confirmRow.hidden = true;
    busy(true);
    say("Making a new passkey. Your device will ask you to confirm.");
    // The status line sits below both panels, out of sight on a short screen.
    if (typeof status.scrollIntoView === "function") status.scrollIntoView({ block: "nearest" });
    withChallenge(function (ch) {
      return navigator.credentials.create({
        publicKey: {
          challenge: challengeBytes(ch),
          rp: { id: ch.rp_id, name: "Schelling Add Forward" },
          // A fresh random handle every time, so a second key never replaces
          // the first in a password manager. Nothing on the server reads it.
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -8 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
          attestation: "none",
          timeout: 120000,
          // Some passkeys make their PRF secret only when asked to at creation.
          extensions: { prf: {} },
        },
      });
    })
      .then(function (credential) {
        var response = credential.response;
        if (typeof response.getPublicKey !== "function" || !response.getPublicKey()) {
          throw new Error("This browser made the passkey but will not hand over its public key, so it cannot be registered. Try a current version of Safari, Chrome, Edge or Firefox.");
        }
        made = credential;
        // The service registers a passkey only once it has seen it sign, so the
        // new passkey is asked for once more. A browser that opens a prompt only
        // from a click refuses this one, and the Confirm button is that click.
        say("Now confirm the new passkey once more, so the service can see it sign.");
        return withChallenge(confirmMade);
      })
      .catch(failed);
  }

  document.getElementById("passkey-create").addEventListener("click", makeKey);
  var offer = document.getElementById("passkey-offer-create");
  if (offer) offer.addEventListener("click", makeKey);

  document.getElementById("passkey-confirm").addEventListener("click", function () {
    if (!made) return;
    busy(true);
    say("Waiting for your new passkey.");
    withChallenge(confirmMade).catch(failed);
  });
})();
