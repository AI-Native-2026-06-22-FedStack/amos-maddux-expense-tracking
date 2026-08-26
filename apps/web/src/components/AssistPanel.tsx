import { FormEvent, useState } from "react";
import { Button } from "../atoms/Button";
import { ApiProblemError } from "../api";
import { type AssistCitation, useAssist } from "../api/useAssist";
import styles from "./AssistPanel.module.css";

export function AssistPanel() {
  const [question, setQuestion] = useState("");
  const assist = useAssist();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedQuestion = question.trim();

    if (trimmedQuestion === "") {
      return;
    }

    assist.mutate({ question: trimmedQuestion });
  };

  return (
    <section className={styles.panel} aria-labelledby="assist-panel-title">
      <div className={styles.header}>
        <h2 className={styles.title} id="assist-panel-title">
          Policy Assist
        </h2>
        <p className={styles.subtitle}>Ask a question about ExpenseFlow policy.</p>
      </div>

      <form className={styles.form} onSubmit={submit}>
        <label className={styles.label} htmlFor="assist-question">
          Question
        </label>
        <textarea
          className={styles.textarea}
          disabled={assist.isPending}
          id="assist-question"
          onChange={(event) => setQuestion(event.target.value)}
          value={question}
        />
        <div className={styles.actions}>
          <Button
            disabled={assist.isPending || question.trim() === ""}
            type="submit"
            variant="primary"
          >
            Ask policy assist
          </Button>
        </div>
      </form>

      {assist.isPending ? (
        <p className={styles.status} role="status">
          Asking policy assist...
        </p>
      ) : null}

      {assist.isError ? (
        <p className={styles.error} role="alert">
          {errorMessage(assist.error)}
        </p>
      ) : null}

      {assist.data !== undefined ? (
        <section className={styles.answer} aria-label="Policy assist answer">
          <h3 className={styles.title}>Answer</h3>
          <p className={styles.answerText}>{assist.data.answer}</p>
          <CitationList citations={assist.data.citations} />
        </section>
      ) : null}
    </section>
  );
}

function CitationList({ citations }: { citations: AssistCitation[] }) {
  return (
    <ul className={styles.citationList} aria-label="Policy citations">
      {citations.map((citation) => (
        <li className={styles.citation} key={`${citation.chunk_id}-${citation.source}`}>
          <span className={styles.citationLabel}>
            {citation.section_id} ({citation.chunk_id})
          </span>
          <CitationSource citation={citation} />
          {citation.quote !== null ? <p className={styles.quote}>{citation.quote}</p> : null}
        </li>
      ))}
    </ul>
  );
}

function CitationSource({ citation }: { citation: AssistCitation }) {
  if (/^https?:\/\//u.test(citation.source)) {
    return (
      <a href={citation.source} rel="noreferrer" target="_blank">
        {citation.source}
      </a>
    );
  }

  return <span>{citation.source}</span>;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiProblemError) {
    return error.detail || error.title;
  }

  return "Policy assist is unavailable.";
}
