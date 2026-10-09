import React, { Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
export default function MarkdownBody({ mode = 'default', headingPlugin, mathRenderer: MathRenderer, children, ...props }) {
  const basic = <ReactMarkdown {...props} remarkPlugins={mode === 'user' ? [remarkGfm, remarkBreaks] : [remarkGfm]}
    rehypePlugins={mode === 'document' && headingPlugin ? [headingPlugin] : []}>{children}</ReactMarkdown>;
  const needsMath = mode !== 'user' && /\$\$|\\\(|\\\[|\\begin\{/.test(String(children || ''));
  return needsMath ? <Suspense fallback={basic}><MathRenderer {...props} headingPlugin={mode === 'document' ? headingPlugin : null}>{children}</MathRenderer></Suspense> : basic;
}
