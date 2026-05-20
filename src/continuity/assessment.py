"""Structured clinical assessment produced after every session."""

from typing import Literal

from pydantic import BaseModel, Field


class DepressionRisk(BaseModel):
    phq9_estimate: int = Field(description="Estimated PHQ-9 equivalent, 0-27")
    severity: Literal["minimal", "mild", "moderate", "moderately severe", "severe"]
    confidence: Literal["low", "medium", "high"]
    evidence: list[str] = Field(description="2-4 short verbatim quotes or observations")


class AdhdIndicators(BaseModel):
    inattention: int = Field(description="0-10 strength of signs in this session's reports")
    hyperactivity_impulsivity: int = Field(description="0-10")
    executive_dysfunction: int = Field(description="0-10 (time blindness, planning, task initiation)")
    emotional_dysregulation: int = Field(description="0-10 (incl. rejection sensitivity)")
    evidence: list[str] = Field(description="2-4 short verbatim quotes or observations")


class Safety(BaseModel):
    level: Literal["none", "low", "moderate", "high"]
    flags: list[str]
    recommended_action: str


class Functioning(BaseModel):
    sleep: int = Field(description="0-10, 10 = healthy sleep")
    work: int = Field(description="0-10, 10 = functioning well at work")
    relationships: int = Field(description="0-10, 10 = connected and stable")
    self_care: int = Field(description="0-10")


class Intervention(BaseModel):
    title: str = Field(description="Short name, e.g. 'Body-doubling with Ben'")
    modality: str = Field(description="e.g. CBT, ACT, psychoeducation, behavioural activation, ADHD coaching, referral")
    rationale: str = Field(description="One sentence, specific to Jonas")
    priority: Literal["now", "next", "later"]


class SessionAssessment(BaseModel):
    headline: str = Field(description="One evocative line capturing this session, max 12 words")
    sentiment: float = Field(description="Overall emotional valence of the client this session, -1.0 to 1.0")
    sentiment_label: str = Field(description="2-4 words, e.g. 'flat, self-critical'")
    turn_sentiments: list[float] = Field(description="Valence -1.0..1.0 for each of the client's turns, in order")
    depression: DepressionRisk
    anxiety_gad7_estimate: int = Field(description="Estimated GAD-7 equivalent, 0-21")
    adhd: AdhdIndicators
    safety: Safety
    functioning: Functioning
    key_themes: list[str] = Field(description="3-5 short themes")
    strengths: list[str] = Field(description="2-4 protective factors / strengths")
    memory_callbacks: list[str] = Field(
        description="Moments where the therapist used remembered information from earlier sessions, and how it landed. Empty for a first session."
    )
    change_since_last: str = Field(description="What changed vs. earlier sessions and why (or 'Baseline session').")
    current_state: str = Field(description="Integrated clinical formulation of where Jonas is now, 3-5 sentences.")
    interventions: list[Intervention] = Field(description="3-5 ideas for upcoming sessions")
    homework: str = Field(description="The one experiment agreed for this week, in plain words")
    next_session_focus: str = Field(description="One sentence")
