import { create } from 'zustand';
import type {
  Client,
  Medication,
  NoteType,
  Provider,
  SessionMode,
  SessionNote,
  SessionState,
} from '@/types/session';

function uid(prefix = ''): string {
  const r = Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}_${Date.now().toString(36)}${r}` : `${Date.now().toString(36)}${r}`;
}

function emptyClient(): Client {
  return {
    name: '',
    phone: '',
    dob: '',
    zip: '',
    county: '',
    state: null,
    planType: null,
    medicaidConfirmed: false,
  };
}

function initialState(): SessionState {
  return {
    sessionId: uid('ses'),
    startedAt: Date.now(),
    mode: 'new_quote',
    client: emptyClient(),
    medications: [],
    providers: [],
    notes: [],
    plansCompared: [],
    recommendation: null,
    complianceChecked: [],
    disclaimersConfirmed: [],
  };
}

interface SessionStore extends SessionState {
  setMode: (mode: SessionMode) => void;
  updateClient: (patch: Partial<Client>) => void;
  addMedication: (med: Omit<Medication, 'id' | 'addedAt'>) => void;
  removeMedication: (id: string) => void;
  addProvider: (p: Omit<Provider, 'id' | 'addedAt'>) => void;
  removeProvider: (id: string) => void;
  addNote: (type: NoteType, body: string) => void;
  removeNote: (id: string) => void;
  resetSession: () => void;
}

export const useSession = create<SessionStore>((set) => ({
  ...initialState(),

  setMode: (mode) => set({ mode }),

  updateClient: (patch) =>
    set((state) => ({ client: { ...state.client, ...patch } })),

  addMedication: (med) =>
    set((state) => ({
      medications: [
        ...state.medications,
        { ...med, id: uid('med'), addedAt: Date.now() },
      ],
    })),

  removeMedication: (id) =>
    set((state) => ({
      medications: state.medications.filter((m) => m.id !== id),
    })),

  addProvider: (p) =>
    set((state) => ({
      providers: [
        ...state.providers,
        { ...p, id: uid('prv'), addedAt: Date.now() },
      ],
    })),

  removeProvider: (id) =>
    set((state) => ({
      providers: state.providers.filter((p) => p.id !== id),
    })),

  addNote: (type, body) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    set((state) => ({
      notes: [
        { id: uid('note'), type, body: trimmed, createdAt: Date.now() },
        ...state.notes,
      ],
    }));
  },

  removeNote: (id) =>
    set((state) => ({ notes: state.notes.filter((n) => n.id !== id) })),

  resetSession: () => set(initialState()),
}));

export const selectNotes = (s: SessionStore): SessionNote[] => s.notes;
export const selectNoteCount = (s: SessionStore): number => s.notes.length;
