"""Typed structured stage-metric record shared by every pipeline stage.

Each of the five pipeline stages (extract, validate, transform, load,
publish_event; see run.py) returns one StageMetrics record alongside its
payload. This is the one shared shape all stages, and run.py's conservation
check, agree on -- new stages or additional per-stage detail should extend
this record rather than each stage inventing its own ad hoc counters.

count_in / count_out / count_bad describe row-level flow through a stage:
  - count_in: rows the stage received.
  - count_out: rows the stage produced for the next stage.
  - count_bad: rows the stage rejected/dropped (did not forward).

A stage that neither drops nor invents rows satisfies count_in == count_out
(count_bad == 0). The validate stage is where this is enforced as a hard,
executable invariant (see ConservationError and run.py); other stages simply
report their own counts honestly so the same invariant could be extended to
them later without changing this shape.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StageMetrics:
    """Row-flow accounting for a single stage of a single pipeline run."""

    stage: str
    run_id: str
    count_in: int
    count_out: int
    count_bad: int

    def __post_init__(self) -> None:
        for field_name in ("count_in", "count_out", "count_bad"):
            value = getattr(self, field_name)
            if value < 0:
                raise ValueError(f"StageMetrics.{field_name} must be >= 0, got {value}")


class ConservationError(RuntimeError):
    """Raised when a stage's count_in != count_out + count_bad.

    This is an executable failure, not a logging concern: a pipeline run
    must stop here rather than silently continuing with rows unaccounted
    for. See validate.py for the stage that raises this.
    """

    def __init__(self, metrics: StageMetrics) -> None:
        self.metrics = metrics
        super().__init__(
            f"conservation violated at stage {metrics.stage!r} (run_id={metrics.run_id!r}): "
            f"count_in={metrics.count_in} != count_out={metrics.count_out} "
            f"+ count_bad={metrics.count_bad} "
            f"(={metrics.count_out + metrics.count_bad})"
        )


def check_conservation(metrics: StageMetrics) -> None:
    """Raise ConservationError unless count_in == count_out + count_bad.

    Callable from any stage, not just validate -- the invariant is general,
    even though validate.py is currently the one stage required to call it.
    """
    if metrics.count_in != metrics.count_out + metrics.count_bad:
        raise ConservationError(metrics)
