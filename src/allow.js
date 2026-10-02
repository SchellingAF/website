// A one-click button that changes something answers only a person who pressed it on
// purpose: Allow on /me/connect, Join and Take over where an invite link brings a
// person, and Accept on an offer of a role, in the mailbox and on a space's page. Each
// carries data-guard, is sent switched off, and is switched on here.
//
// Allow can be pressed by a double click stolen from another site: a page asks for a
// double click and puts this page in front of the pointer between the two clicks, so
// the second lands on Allow. Framing the page is refused already; this is the attack
// that needs no frame. A page can also keep its visitor clicking again and again on
// one spot, and swap this page in under the stream of clicks. Join, Take over and
// Accept face the same: another site can send a signed-in browser to an invite link,
// or to the mailbox, and the page it gets carries the real form token, so only the
// press itself can tell a person from a steered click.
//
// So a press of a guarded button counts only when all of these hold, and otherwise the
// form is not sent and the note beside the button says to press it again:
//   - the page has been in front, in the window with the keyboard, for 800
//     milliseconds, which a click that arrives with the page cannot have;
//   - by pointer, the pointer really moved since the page came in front, which a
//     click on a spot the visitor was already clicking does not do (a finger does
//     not hover, so a touch counts as moving), and no other press came in the second
//     before, which a stream of clicks always has;
//   - or by keyboard, Enter or Space on that button itself, which only reaching it on
//     purpose with Tab gives.
// It sends no request and reads nothing but these. Without script a guarded button
// stays switched off, and the page says why.

(function () {
  "use strict";

  var guarded = Array.prototype.filter.call(document.querySelectorAll("button[data-guard]"), function (button) {
    return button.form;
  });
  if (!guarded.length) return;

  var IN_FRONT_MS = 800;
  var QUIET_MS = 1000;
  var RECENT_MS = 1000;

  var frontSince = 0;
  var moved = false;
  var lastX = null;
  var lastY = null;
  var press = 0;
  var pressBefore = 0;
  var keyed = 0;
  var keyedOn = null;

  function inFront() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  function watch() {
    if (!inFront()) {
      frontSince = 0;
      moved = false;
    } else if (frontSince === 0) {
      frontSince = Date.now();
    }
  }

  // A move counts when the pointer is somewhere it was not: a browser's own move
  // after the page changed under a still pointer reports the same place.
  function position(event) {
    watch();
    if (lastX !== null && (event.clientX !== lastX || event.clientY !== lastY) && frontSince !== 0) moved = true;
    lastX = event.clientX;
    lastY = event.clientY;
  }

  document.addEventListener("visibilitychange", watch);
  window.addEventListener("focus", watch);
  window.addEventListener("blur", watch);
  window.addEventListener("pageshow", watch);
  document.addEventListener("pointermove", position, true);
  document.addEventListener("pointerdown", function (event) {
    position(event);
    if (event.pointerType === "touch" && frontSince !== 0) moved = true;
    pressBefore = press;
    press = Date.now();
  }, true);
  document.addEventListener("keydown", function (event) {
    watch();
    if (guarded.indexOf(event.target) !== -1 && (event.key === "Enter" || event.key === " ")) {
      keyed = Date.now();
      keyedOn = event.target;
    }
  }, true);

  guarded.forEach(function (button) {
    // The note in the button's own form, or the page's one.
    var note = button.form.querySelector("[data-guard-note]") || document.querySelector("[data-guard-note]");
    button.form.addEventListener("submit", function (event) {
      var now = Date.now();
      var ready = inFront() && frontSince !== 0 && now - frontSince >= IN_FRONT_MS;
      var byKeyboard = keyedOn === button && now - keyed < RECENT_MS;
      var byPointer = moved && press !== 0 && now - press < RECENT_MS && (pressBefore === 0 || press - pressBefore >= QUIET_MS);
      if (ready && (byKeyboard || byPointer)) return;
      event.preventDefault();
      if (note) {
        var label = button.textContent;
        note.textContent = "Not done yet: " + label + " was pressed as this page came in front, or straight after another click. " +
          "Read the page, move to " + label + ", and press it again.";
      }
    });
    button.disabled = false;
  });
  watch();
})();
