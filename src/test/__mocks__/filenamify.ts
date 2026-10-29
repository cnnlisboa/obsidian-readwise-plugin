const filenamify = (str: string, options?: { replacement?: string; maxLength?: number }) => {
  const replacement = options?.replacement ?? '_';
  const maxLength = options?.maxLength ?? 252;

  // Replace invalid characters with the specified replacement
  // The control range is intentional: file names must exclude these characters.
  // eslint-disable-next-line no-control-regex
  const sanitized = str.replace(/[<>:"/\\|?*\x00-\x1F]/g, replacement);

  // Truncate to maxLength
  return sanitized.slice(0, maxLength);
};

export default filenamify;
