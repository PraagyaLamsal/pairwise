export interface CourseProfile {
  /** One-paragraph summary of what the course covers so far. */
  summary: string;
  /** Topics found in the material, in teaching order where known (lecture order). */
  topics: { title: string; source: string }[];
  /** Course-specific terms with the course's own definitions. */
  glossary: { term: string; definition: string; source: string }[];
  /** Notation/conventions the course uses (e.g. "uses Python 3 with snake_case", "uses ⊆ for subset"). */
  conventions: string[];
  /** Things explicitly out of scope / taught later, when the material says so. */
  laterTopics: string[];
  generatedAt: number;
  generatedBy: 'gemini' | 'heuristic';
}

export interface IndexStatus {
  state: 'never' | 'indexing' | 'ready' | 'error';
  files: number;
  chunks: number;
  embedded: number;
  updatedAt?: number;
  error?: string;
  skipped?: { file: string; reason: string }[];
}

export interface Course {
  id: string;
  /** e.g. "COMP 1405" */
  code: string;
  /** e.g. "Introduction to Computer Science I" */
  name: string;
  color: string;
  /** Absolute path of the linked course folder. */
  folder?: string;
  term?: string;
  createdAt: number;
  lastSessionAt?: number;
  totalSessionMs?: number;
  sessionCount?: number;
  /** Relative paths (inside folder) the student marked as assignment specs. */
  assignments: string[];
  indexStatus: IndexStatus;
  profile?: CourseProfile;
}

export interface CourseChunk {
  id: string;
  file: string; // relative path
  /** Human citation label, e.g. "Lecture 5 – Recursion.pdf, slide 12". */
  cite: string;
  lecture?: number;
  page?: number;
  slide?: number;
  timestamp?: string;
  heading?: string;
  text: string;
  kind: 'slides' | 'pdf' | 'doc' | 'notes' | 'transcript' | 'code' | 'assignment';
}

export interface SearchHit {
  chunk: CourseChunk;
  score: number;
  via: ('bm25' | 'embedding')[];
}

/** Saved per course so a later session can pick up where the last one stopped. */
export interface ResumeState {
  courseId: string;
  savedAt: number;
  summary: string;
  openQuestions: string[];
  toReview: string[];
  transcriptTail: { speaker: 'student' | 'tutor'; text: string }[];
  liveHandle?: { handle: string; savedAt: number; model: string };
  lastNotesFile?: string;
  /** Last session's "Show me" questions: how many they got right. */
  checks?: { right: number; total: number };
}

export const COURSE_COLORS = ['#2F7BFF', '#16A34A', '#E5484D', '#9B5DE5', '#F59E0B', '#0EA5E9', '#EC4899', '#14B8A6'];
