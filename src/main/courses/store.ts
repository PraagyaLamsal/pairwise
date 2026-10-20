import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { COURSE_COLORS, type Course, type ResumeState } from '@shared/courses';
import { readJson, writeJson } from '../store/json-store';

export class CourseStore extends EventEmitter {
  private courses: Course[];
  private readonly file: string;

  constructor(private readonly dataDir: string) {
    super();
    this.file = join(dataDir, 'courses.json');
    this.courses = readJson<Course[]>(this.file, []).map(normalize);
  }

  list(): Course[] {
    return [...this.courses].sort((a, b) => (b.lastSessionAt ?? b.createdAt) - (a.lastSessionAt ?? a.createdAt));
  }

  get(id: string): Course | undefined {
    return this.courses.find((c) => c.id === id);
  }

  create(input: { code: string; name: string; color?: string; folder?: string; term?: string }): Course {
    const course: Course = normalize({
      id: randomUUID(),
      code: input.code.trim() || 'Course',
      name: input.name.trim(),
      color: input.color ?? COURSE_COLORS[this.courses.length % COURSE_COLORS.length],
      folder: input.folder,
      term: input.term,
      createdAt: Date.now(),
      assignments: [],
      indexStatus: { state: 'never', files: 0, chunks: 0, embedded: 0 },
    });
    this.courses.push(course);
    this.save();
    return course;
  }

  update(id: string, patch: Partial<Course>): Course {
    const idx = this.courses.findIndex((c) => c.id === id);
    if (idx < 0) throw new Error(`No course ${id}`);
    const { id: _ignored, ...rest } = patch;
    this.courses[idx] = normalize({ ...this.courses[idx], ...rest });
    this.save();
    return this.courses[idx];
  }

  delete(id: string): void {
    this.courses = this.courses.filter((c) => c.id !== id);
    this.save();
  }

  recordSession(id: string, durationMs: number): void {
    const c = this.get(id);
    if (!c) return;
    this.update(id, {
      lastSessionAt: Date.now(),
      totalSessionMs: (c.totalSessionMs ?? 0) + durationMs,
      sessionCount: (c.sessionCount ?? 0) + 1,
    });
  }

  label(c: Course): string {
    return c.name ? `${c.code} · ${c.name}` : c.code;
  }

  // Resume state -------------------------------------------------------------
  resumeFile(courseId: string): string {
    return join(this.dataDir, 'resume', `${courseId}.json`);
  }

  getResume(courseId: string): ResumeState | null {
    return readJson<ResumeState | null>(this.resumeFile(courseId), null);
  }

  saveResume(state: ResumeState): void {
    writeJson(this.resumeFile(state.courseId), state);
  }

  indexDir(courseId: string): string {
    return join(this.dataDir, 'index', courseId);
  }

  /** Where session notes go for a course without a linked folder. */
  notesDir(courseId: string): string {
    return join(this.dataDir, 'notes', courseId);
  }

  private save(): void {
    writeJson(this.file, this.courses);
    this.emit('changed', this.list());
  }
}

function normalize(c: Course): Course {
  return {
    ...c,
    assignments: Array.isArray(c.assignments) ? c.assignments : [],
    indexStatus: c.indexStatus ?? { state: 'never', files: 0, chunks: 0, embedded: 0 },
  };
}
