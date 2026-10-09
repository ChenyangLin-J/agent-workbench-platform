import React from 'react';
import MarkdownBody from './markdown-body.jsx';
import MathMarkdown from './markdown-math.jsx';

// Default consumers, including SSR, keep synchronous Markdown rendering.
export default function MarkdownRenderer(props) {
  return <MarkdownBody {...props} mathRenderer={MathMarkdown} />;
}
