import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export default function MathMarkdown({ headingPlugin, ...props }) {
  return <ReactMarkdown {...props} remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
    rehypePlugins={[...(headingPlugin ? [headingPlugin] : []), [rehypeKatex, { strict: false }]]} />;
}
