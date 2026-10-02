// The passkey prompt that confirms a new access token, on /me/tokens/new. It sends no
// request. The page carries the challenge the server asked the product for when it
// drew the form, the prompt opens inside the press itself, which older Safari needs,
// and the form is sent with the passkey's answer, which the server passes on to the
// product. The token that comes back is shown in the answer to that form, once, and
// this script never sees it.
//
// A passkey signs whatever challenge its prompt carries, so no prompt opens for one
// that is not the product's challenge to connect with, which is what makes a token: a
// post's would get back the person's signature on a post they never wrote. The server
// draws no other into the page, and src/sign-in-challenge.js says what one is.

import { signInChallenge } from "/sign-in-challenge.js";

(function () {
  "use strict";

  var form = document.querySelector("form[data-new-token]");
  if (!form) return;
  var status = form.querySelector("[data-token-status]");
  var button = form.querySelector("button[type=submit]");

  function say(text) {
    status.textContent = text;
  }

  if (!window.PublicKeyCredential || !navigator.credentials) {
    say("This browser cannot use a passkey. Try a current version of Safari, Chrome, Edge or Firefox.");
    if (button) button.disabled = true;
    return;
  }

  // The challenge lasts a few minutes from when the page was drawn; past that the
  // product would refuse the answer, so the page says so before asking.
  var deadline = Date.now() + Number(form.getAttribute("data-valid-for") || "0") * 1000;

  function b64u(buffer) {
    var bytes = new Uint8Array(buffer);
    var text = "";
    for (var i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
    return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromB64u(text) {
    var binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function field(name) {
    return form.elements.namedItem(name);
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    if (Date.now() > deadline) {
      say("This page's passkey challenge has run out. Reload the page, then press the button again. Nothing was made.");
      return;
    }
    // Checked here, with nothing awaited, so the prompt still opens inside the press.
    var challenge = signInChallenge(field("challenge").value);
    if (!challenge) {
      say("The service asked for a signature on something other than this access token, so your passkey was not asked to sign it. Nothing was made.");
      return;
    }
    var options = { challenge: challenge, userVerification: "required", timeout: 120000 };
    var rpId = form.getAttribute("data-rp-id");
    if (rpId) options.rpId = rpId;
    var credential = form.getAttribute("data-credential");
    if (credential) options.allowCredentials = [{ type: "public-key", id: fromB64u(credential) }];
    say("Your browser is asking for your passkey.");
    navigator.credentials.get({ publicKey: options }).then(function (answer) {
      if (!answer || !answer.response || !answer.response.signature) throw new Error("no answer");
      field("credential_id").value = b64u(answer.rawId);
      field("client_data_json").value = b64u(answer.response.clientDataJSON);
      field("authenticator_data").value = b64u(answer.response.authenticatorData);
      field("signature").value = b64u(answer.response.signature);
      say("Confirmed. Making the access token.");
      // Sending the form this way does not fire this listener again.
      form.submit();
    }, function (error) {
      say(error && error.name === "NotAllowedError"
        ? "The passkey prompt was closed before it finished. Nothing was made."
        : "Your passkey did not answer, so nothing was made. Try again.");
    });
  });
})();
