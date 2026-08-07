import type { GitLocationInput, VerifiedGitLocation } from "../src/types.js";

export const GIT_INPUT: GitLocationInput = {
  remoteUrl: "https://git.example.test/company/company-os.git",
  branch: "agents/company-os",
  commit: "a".repeat(40),
};

export const VERIFIED_GIT: VerifiedGitLocation = {
  ...GIT_INPUT,
  verifiedAt: "2030-01-02T03:04:05.000Z",
};

export const fakeGitRemoteVerifier = {
  verify: async (input: GitLocationInput): Promise<VerifiedGitLocation> => ({
    ...input,
    commit: input.commit.toLowerCase(),
    verifiedAt: VERIFIED_GIT.verifiedAt,
  }),
};
