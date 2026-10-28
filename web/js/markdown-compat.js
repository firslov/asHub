/* Keep this file identical in web/js and remote/public. */
(() => {
  const parser = globalThis.marked;
  if (!parser?.use || parser.ashubCjkStrong) return;
  const standardStrong = parser.Tokenizer.prototype.emStrong;
  const han = /\p{Script=Han}/u;
  const cjkPunctuation = /[。！？；：、，…“”‘’「」『』（）《》〈〉【】〔〕]/u;

  parser.use({ tokenizer: {
    emStrong(src, maskedSrc, prevChar) {
      // Preserve CommonMark's choices, including nesting and delimiter runs.
      const standard = standardStrong.call(this, src, maskedSrc, prevChar);
      if (standard) return standard;
      if (!src.startsWith('**') || src[2] === '*' || /\s/u.test(src[2] || '') ||
          this.lexer.state.inRawBlock) return;
      const offset = maskedSrc.length - src.length;
      const visible = maskedSrc.slice(offset);
      if (!visible.startsWith('**') || maskedSrc[offset - 1] === '*') return;
      // Be conservative around raw math and escaped punctuation. Marked masks
      // escapes as ++; desktop math is already extracted before parsing.
      if (maskedSrc.includes('$') || maskedSrc.includes('++')) return;
      const close = visible.indexOf('**', 2);
      if (close < 3 || visible[close - 1] === '*' || visible[close + 2] === '*') return;
      const text = src.slice(2, close);
      if (/[\r\n]/u.test(text) || /\s$/u.test(text) || !han.test(text)) return;
      const beforeClose = text.at(-1);
      const afterClose = src[close + 2] || '';
      const cjkOpening = han.test(prevChar || '') && cjkPunctuation.test(text[0]);
      const cjkClosing = cjkPunctuation.test(beforeClose) && han.test(afterClose);
      if (!cjkOpening && !cjkClosing) return;
      return {
        type: 'strong', raw: src.slice(0, close + 2), text,
        tokens: this.lexer.inlineTokens(text),
      };
    },
  } });
  Object.defineProperty(parser, 'ashubCjkStrong', { value: true });
})();
