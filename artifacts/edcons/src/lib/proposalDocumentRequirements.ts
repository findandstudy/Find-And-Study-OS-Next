import type {
  ProposalStudyLevelDocuments,
} from "./generateProposalPdf";

export type RawProposalDocumentRequirement = {
  documentType: string;
  mandatory: boolean;
  sortOrder?: number;
};

type ProgramWithStudyLevel = {
  degree?: string | null;
};

function uniqueStudyLevels(levels: readonly string[]): string[] {
  const levelsByKey = new Map<string, string>();
  for (const value of levels) {
    const level = value.trim();
    if (!level) continue;
    const key = level.toLocaleLowerCase("en-US");
    if (!levelsByKey.has(key)) levelsByKey.set(key, level);
  }
  return [...levelsByKey.values()];
}

export function collectProposalStudyLevels(
  programs: readonly ProgramWithStudyLevel[],
  fallbackLevels: readonly string[] = [],
): string[] {
  const programLevels = uniqueStudyLevels(
    programs.flatMap((program) => program.degree ? [program.degree] : []),
  );
  return programLevels.length > 0 ? programLevels : uniqueStudyLevels(fallbackLevels);
}

export async function loadProposalDocumentRequirements({
  studyLevels,
  fetchRequirements,
  resolveLabel,
}: {
  studyLevels: readonly string[];
  fetchRequirements: (studyLevel: string) => Promise<RawProposalDocumentRequirement[]>;
  resolveLabel: (documentType: string) => string;
}): Promise<{
  documentRequirements: ProposalStudyLevelDocuments[];
  missingStudyLevels: string[];
}> {
  const results = await Promise.all(
    uniqueStudyLevels(studyLevels).map(async (studyLevel) => {
      const requirements = await fetchRequirements(studyLevel);
      if (!Array.isArray(requirements) || requirements.length === 0) {
        return { studyLevel, requirements: null };
      }
      return {
        studyLevel,
        requirements: [...requirements]
          .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
          .map((requirement) => ({
            documentType: requirement.documentType,
            label: resolveLabel(requirement.documentType),
            mandatory: !!requirement.mandatory,
          })),
      };
    }),
  );

  return {
    documentRequirements: results.flatMap((result) => result.requirements
      ? [{ studyLevel: result.studyLevel, requirements: result.requirements }]
      : []),
    missingStudyLevels: results.flatMap((result) => result.requirements
      ? []
      : [result.studyLevel]),
  };
}
