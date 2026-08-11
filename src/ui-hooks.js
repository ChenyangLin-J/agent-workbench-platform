import { useEffect, useState } from 'react';

export function useSessionUserInput({ request = {}, onRespond }) {
  const [answers, setAnswers] = useState({});
  const [status, setStatus] = useState('idle');
  const questions = request.questions || [];
  const containsSecret = questions.some((question) => question.isSecret);
  const complete = questions.length > 0 && questions.every(
    (question) => String(answers[question.id] || '').trim(),
  );

  useEffect(() => {
    setAnswers({});
    setStatus('idle');
  }, [request.token]);

  function choose(questionId, value) {
    if (status === 'saving') return;
    setAnswers((current) => ({ ...current, [questionId]: value }));
  }

  async function submit() {
    if (!complete || containsSecret || status === 'saving' || !onRespond) return;
    setStatus('saving');
    try {
      await onRespond({
        token: request.token,
        answers: Object.fromEntries(questions.map((question) => [
          question.id,
          { answers: [String(answers[question.id]).trim()] },
        ])),
      });
      setStatus('saved');
    } catch (error) {
      setStatus('error');
      throw error;
    }
  }

  return {
    answers,
    canSubmit: Boolean(onRespond && complete && !containsSecret && status !== 'saving'),
    choose,
    complete,
    containsSecret,
    questions,
    saving: status === 'saving',
    status,
    submit,
  };
}

