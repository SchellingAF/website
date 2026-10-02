/* The copy buttons on /api.
 *
 * Every block on that page is something a person moves into somewhere else: a
 * connector address into an app's settings field, two commands into a Claude Code
 * session, a JSON object into a configuration file, seven lines into their own
 * project instructions. Selecting a multi-line <pre> with a trackpad and missing
 * the last line is how a configuration file ends up one brace short, and the
 * person who did it has no way to tell.
 *
 * The buttons are made here rather than written into the page, so with this script
 * blocked or broken the page carries no button that does nothing: the text is
 * still there, still selectable, and still correct. That is also why the label
 * says COPY rather than an icon -- there is nothing to load, and nothing to guess.
 *
 * No inline handler and no inline text: build.mjs fails a page that carries either,
 * because code in a page can load from anywhere, and this file is served from this
 * origin under script-src 'self'.
 */
(function () {
  "use strict";

  var DONE_MS = 1600;

  /* Three ways, in falling order of what the browser has to offer.
     1. The asynchronous clipboard, which needs a secure context. https:// and
        http://localhost both are; a plain http:// origin is not, and there the
        call is either missing or rejects.
     2. execCommand, deprecated and still the only thing that works on an
        insecure origin. It copies the selection, so the text goes into a
        textarea off-screen first.
     3. Neither. Then the block's own text is selected, so one keystroke finishes
        the job, and the button says so instead of claiming success. */
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen rather than hidden: a display:none or visibility:hidden field
    // cannot be selected, so the copy silently does nothing.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    var ok = false;
    try {
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function selectBlock(pre) {
    try {
      var range = document.createRange();
      range.selectNodeContents(pre);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      /* Selecting is the consolation prize; failing to select is not worth an error. */
    }
  }

  function wire(block) {
    var head = block.querySelector(".block-head");
    var pre = block.querySelector("pre");
    if (!head || !pre) return;

    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "COPY";
    /* The label names what is copied, so a screen reader announces "copy your
       configuration file" rather than the fourth "copy" on the page. */
    var what = (head.textContent || "").trim().toLowerCase();
    button.setAttribute("aria-label", what ? "Copy " + what : "Copy");

    var say = document.createElement("span");
    say.className = "copy-said";
    /* polite, not assertive: this interrupts nothing a person is reading. */
    say.setAttribute("aria-live", "polite");

    var timer = null;
    function said(word, cls) {
      button.textContent = word;
      button.className = "copy " + cls;
      say.textContent = word === "COPIED" ? "Copied." : "Select the text and copy it yourself.";
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        button.textContent = "COPY";
        button.className = "copy";
        say.textContent = "";
      }, DONE_MS);
    }

    button.addEventListener("click", function () {
      /* textContent, never innerHTML: the page escapes "+" and ">" into markup and
         the parser has already turned them back, so this is the same bytes the
         build wrote. Reading the markup instead would copy "&gt;" into a
         configuration file. */
      var text = pre.textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          said("COPIED", "copy-done");
        }, function () {
          if (legacyCopy(text)) said("COPIED", "copy-done");
          else { selectBlock(pre); said("SELECTED", "copy-warn"); }
        });
        return;
      }
      if (legacyCopy(text)) said("COPIED", "copy-done");
      else { selectBlock(pre); said("SELECTED", "copy-warn"); }
    });

    head.appendChild(button);
    head.appendChild(say);
  }

  var blocks = document.querySelectorAll(".block");
  for (var i = 0; i < blocks.length; i++) wire(blocks[i]);
})();
