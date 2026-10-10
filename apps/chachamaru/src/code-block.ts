/**
 * A Markdown code block of text that may hold backticks itself: its fence is
 * longer than any run of backticks in the text.
 */
export const codeBlock = (text: string, language = ""): string => {
  const longest = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/gu), ([run]) => run.length)
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${text.endsWith("\n") ? text : `${text}\n`}${fence}`;
};
