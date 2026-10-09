import React, { Suspense } from 'react';
const Renderer = React.lazy(() => import('./markdown-renderer-lazy.jsx'));
class MarkdownBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
// Optional browser entry. Raw text remains readable while loading or on failure.
export function SessionMarkdown(props) {
  const fallback = <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{props.children}</span>;
  return <MarkdownBoundary fallback={fallback}><Suspense fallback={fallback}><Renderer {...props} /></Suspense></MarkdownBoundary>;
}
