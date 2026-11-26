import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { MissionRevisionSourceInput } from "@paperclipai/shared/types/mission-revision";

interface NewIssueDefaults {
  status?: string;
  priority?: string;
  projectId?: string;
  missionId?: string;
  parentId?: string;
  assigneeAgentId?: string;
  assigneeUserId?: string;
  title?: string;
  description?: string;
}

// [수정 요청 미션] 미션 생성 다이얼로그 사전 채움 값 — MissionDetail의 수정 요청 버튼이 사용.
interface NewMissionDefaults extends MissionRevisionSourceInput {
  title?: string;
  description?: string;
  ownerAgentId?: string;
}

interface OnboardingOptions {
  initialStep?: 1 | 2 | 3 | 4;
  companyId?: string;
}

interface DialogContextValue {
  newIssueOpen: boolean;
  newIssueDefaults: NewIssueDefaults;
  openNewIssue: (defaults?: NewIssueDefaults) => void;
  closeNewIssue: () => void;
  newProjectOpen: boolean;
  openNewProject: () => void;
  closeNewProject: () => void;
  newMissionOpen: boolean;
  newMissionDefaults: NewMissionDefaults;
  openNewMission: (defaults?: NewMissionDefaults) => void;
  closeNewMission: () => void;
  newAgentOpen: boolean;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  onboardingOpen: boolean;
  onboardingOptions: OnboardingOptions;
  openOnboarding: (options?: OnboardingOptions) => void;
  closeOnboarding: () => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [newIssueOpen, setNewIssueOpen] = useState(false);
  const [newIssueDefaults, setNewIssueDefaults] = useState<NewIssueDefaults>({});
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newMissionOpen, setNewMissionOpen] = useState(false);
  const [newMissionDefaults, setNewMissionDefaults] = useState<NewMissionDefaults>({});
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingOptions, setOnboardingOptions] = useState<OnboardingOptions>({});

  const openNewIssue = useCallback((defaults: NewIssueDefaults = {}) => {
    setNewIssueDefaults(defaults);
    setNewIssueOpen(true);
  }, []);

  const closeNewIssue = useCallback(() => {
    setNewIssueOpen(false);
    setNewIssueDefaults({});
  }, []);

  const openNewProject = useCallback(() => {
    setNewProjectOpen(true);
  }, []);

  const closeNewProject = useCallback(() => {
    setNewProjectOpen(false);
  }, []);

  // [수정 요청 미션] 원본 미션 맥락(제목/설명/오너)을 사전 채움 — openNewIssue(defaults) 패턴과 동일.
  const openNewMission = useCallback((defaults: NewMissionDefaults = {}) => {
    setNewMissionDefaults(defaults);
    setNewMissionOpen(true);
  }, []);

  const closeNewMission = useCallback(() => {
    setNewMissionOpen(false);
    setNewMissionDefaults({});
  }, []);

  const openNewAgent = useCallback(() => {
    setNewAgentOpen(true);
  }, []);

  const closeNewAgent = useCallback(() => {
    setNewAgentOpen(false);
  }, []);

  const openOnboarding = useCallback((options: OnboardingOptions = {}) => {
    setOnboardingOptions(options);
    setOnboardingOpen(true);
  }, []);

  const closeOnboarding = useCallback(() => {
    setOnboardingOpen(false);
    setOnboardingOptions({});
  }, []);

  return (
    <DialogContext.Provider
      value={{
        newIssueOpen,
        newIssueDefaults,
        openNewIssue,
        closeNewIssue,
        newProjectOpen,
        openNewProject,
        closeNewProject,
        newMissionOpen,
        newMissionDefaults,
        openNewMission,
        closeNewMission,
        newAgentOpen,
        openNewAgent,
        closeNewAgent,
        onboardingOpen,
        onboardingOptions,
        openOnboarding,
        closeOnboarding,
      }}
    >
      {children}
    </DialogContext.Provider>
  );
}

export function useDialog() {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error("useDialog must be used within DialogProvider");
  }
  return ctx;
}

export function useOptionalDialog() {
  return useContext(DialogContext);
}
