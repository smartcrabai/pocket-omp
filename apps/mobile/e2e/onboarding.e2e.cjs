describe("Pocket OMP onboarding", () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true, delete: true });
  });

  it("explains the security boundary and opens PKCE sign in", async () => {
    await expect(element(by.text("Your agent, within reach."))).toBeVisible();
    await expect(element(by.text("PAIRWISE E2EE"))).toBeVisible();
    await element(by.id("sign-in-button")).tap();
    await expect(element(by.text("Authenticate without sharing provider keys."))).toBeVisible();
    await expect(
      element(
        by.text(
          "Set EXPO_PUBLIC_OIDC_ISSUER and EXPO_PUBLIC_OIDC_CLIENT_ID in the Development Build.",
        ),
      ),
    ).toBeVisible();
  });
});
