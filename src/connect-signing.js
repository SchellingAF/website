// Letting an app sign a person's posts, on /me/connect, in their browser.
//
// An app that connects by sign-in gets an access token and nothing else, so its posts
// would go out unsigned. When the box "Let this app sign your posts" is ticked, this
// script makes the connection a key of its own, D, an Ed25519 key pair made with Web
// Crypto, writes the statement that lets D sign for the person's key on this one
// connection (src/connection-key.js), and on Allow asks the passkey to sign it, once.
// The statement, the passkey's answer and D's 32-byte seed go with the Allow form; this
// site's server passes them to the product, which keeps D sealed under the app's access
// token and signs each post the app sends with it.
//
// A PASSKEY SIGNS WHATEVER CHALLENGE ITS PROMPT CARRIES, so the challenge here is never
// one handed to the page: the script writes the statement itself, from the fields the
// server drew for this request (the request's id, the key's id, the token's lifetime and
// the time the page was drawn, by the server's clock) and from the key it made, and the
// passkey signs the hash of that statement under its own label.
//
// The key is made and the statement written as the page loads, because nothing may be
// awaited between the press and the prompt: Safari before macOS 14.4 and iOS 17.4 opens a
// passkey prompt only from inside the click. The prompt opens in the form's submit, after
// src/allow.js has counted the press, which it registered first: a classic script runs
// as the page is read, a module only once it has been.
//
// Unticked, nothing is added and Allow connects the app unsigned, as it did before. In a
// browser without a passkey or without Ed25519 in Web Crypto, the script unticks the box
// and switches it off, and says why, so the form says unsigned before anybody presses
// Allow. A ticked box that reaches the server with nothing beside it, because this script
// never handled the press, connects nothing (src/connect.ts), and neither does what this
// script makes arriving with the box unticked. The answer is in the form only between the
// passkey's answer and the form's sending: the fields are emptied as soon as the form is
// sent, even when sending throws, the box and Allow are switched off, and a page the
// browser brings back from its history is drawn afresh. It sends no request: the page's
// policy permits this site's own scripts and no request of any kind.

import { notAfterOf, signedBytes, statementBytes } from "/connection-key.js";

(function () {
  "use strict";

  var form = document.querySelector("form[data-connection-key]");
  if (!form) return;
  var box = form.elements.namedItem("sign_posts");
  if (!box) return;
  var status = document.querySelector("[data-sign-status]");

  var FIELDS = ["ck_statement", "ck_seed", "ck_credential_id", "ck_client_data_json", "ck_authenticator_data", "ck_signature"];
  var CANNOT = "This browser cannot make the key an app signs with, so the app's posts will not be signed.";
  var NOT_PREPARED = "This page could not prepare the key the app signs with, so the app's posts will not be signed.";

  function say(text) {
    if (status) status.textContent = text;
  }

  function field(name) {
    return form.elements.namedItem(name);
  }

  function clear() {
    for (var i = 0; i < FIELDS.length; i++) if (field(FIELDS[i])) field(FIELDS[i]).value = "";
  }

  // The box off, and why: Allow then connects the app unsigned.
  function off(why) {
    box.checked = false;
    box.disabled = true;
    say(why);
  }

  function b64u(buffer) {
    var bytes = new Uint8Array(buffer);
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64u(text) {
    var binary = atob(String(text).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(text).length + 3) % 4));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function hex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }

  if (!window.PublicKeyCredential || !navigator.credentials || typeof crypto === "undefined" || !crypto.subtle) {
    off(CANNOT);
    return;
  }

  var allow = form.querySelector("button[type=submit]");

  // A page the browser brings back from its history after Allow is the page as it was:
  // it is drawn afresh instead, with a new key and the request's state as it is now.
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) window.location.reload();
  });

  // A whole number the server drew, written as one, or NaN.
  function whole(name) {
    var text = form.getAttribute(name);
    return typeof text === "string" && /^[1-9][0-9]{0,15}$/.test(text) ? Number(text) : NaN;
  }

  // What the server drew for this request, read before any key is made: a field out of
  // shape makes no statement at all.
  var drawn = {
    connection: form.getAttribute("data-connection"),
    peerId: form.getAttribute("data-peer"),
    notBefore: whole("data-not-before"),
    notAfter: notAfterOf(whole("data-not-before"), whole("data-lifetime-days")),
  };

  // { statement, seed, challenge } once the key is made and the statement written.
  var ready = null;
  var preparing = true;

  function prepare() {
    if (drawn.notAfter === null) return Promise.reject(new Error(NOT_PREPARED));
    return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]).catch(function () {
      throw new Error(CANNOT);
    }).then(function (pair) {
      return crypto.subtle.exportKey("jwk", pair.privateKey);
    }).then(function (jwk) {
      var seed = fromB64u(jwk && jwk.d || "");
      var key = fromB64u(jwk && jwk.x || "");
      if (seed.length !== 32 || key.length !== 32) throw new Error(CANNOT);
      var statement;
      try {
        statement = statementBytes({ peerId: drawn.peerId, key: hex(key), connection: drawn.connection, notBefore: drawn.notBefore, notAfter: drawn.notAfter });
      } catch (error) {
        throw new Error(NOT_PREPARED);
      }
      return crypto.subtle.digest("SHA-256", signedBytes(statement)).then(function (hash) {
        return { statement: b64u(statement), seed: b64u(seed), challenge: new Uint8Array(hash) };
      });
    });
  }

  prepare().then(function (made) {
    ready = made;
    preparing = false;
  }, function (error) {
    preparing = false;
    off(error && error.message === NOT_PREPARED ? NOT_PREPARED : CANNOT);
  });

  form.addEventListener("submit", function (event) {
    // A press src/allow.js did not count: nothing is asked, and its note says why.
    if (event.defaultPrevented) return;
    // Every press starts empty: an answer left from a press whose sending never
    // finished goes nowhere. The form's own submit() below does not come back here.
    clear();
    if (!box.checked) return;
    event.preventDefault();
    if (!ready) {
      say(preparing ? "Still making the key the app signs with. Press Allow again in a moment." : NOT_PREPARED);
      return;
    }
    var made = ready;
    var options = { challenge: made.challenge, userVerification: "required", timeout: 120000 };
    var rpId = form.getAttribute("data-rp-id");
    if (rpId) options.rpId = rpId;
    var credential = form.getAttribute("data-credential");
    options.allowCredentials = credential ? [{ type: "public-key", id: fromB64u(credential) }] : [];
    say("Your browser is asking for your passkey, to let this app sign your posts.");
    navigator.credentials.get({ publicKey: options }).then(function (answer) {
      if (!answer || !answer.response || !answer.response.signature) throw new Error("no answer");
      // The box unticked while the passkey was asked: the form would say unsigned and carry
      // a key, so nothing goes.
      if (!box.checked) {
        say("You unticked the box, so nothing was sent. Press Allow again to allow the app without signing your posts.");
        return;
      }
      try {
        field("ck_statement").value = made.statement;
        field("ck_seed").value = made.seed;
        field("ck_credential_id").value = b64u(answer.rawId);
        field("ck_client_data_json").value = b64u(answer.response.clientDataJSON);
        field("ck_authenticator_data").value = b64u(answer.response.authenticatorData);
        field("ck_signature").value = b64u(answer.response.signature);
        say("Signed. Allowing the app.");
        ready = null;
        form.submit();
      } finally {
        // The form's entries are taken as it is sent, so the seed leaves the page with it
        // and is kept in no field, a browser's history included; and if anything above
        // threw, no field keeps it either.
        clear();
      }
      // Sent: nothing on this page sends it again. Switched off only now, because a
      // switched-off box would have gone without its value.
      box.disabled = true;
      if (allow) allow.disabled = true;
    }).catch(function () {
      clear();
      say("Your passkey did not sign, so nothing was sent. Press Allow to try again, or untick the box to allow the app without signing your posts.");
    });
  });
})();
