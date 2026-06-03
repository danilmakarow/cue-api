import {
  AcknowledgeOptions,
  ExternalVendor,
  MediaPayload,
  MediaRef,
  NormalizedInboundMessage,
  OutboundActions,
  OutboundMessage,
  SendTarget,
  VendorCapabilities,
  VendorMessageRef,
  WebhookJob,
  WebhookRequest,
} from './external-vendor.types';

/**
 * Vendor-agnostic connector contract. Concrete connectors (Telegram first)
 * translate between a vendor's wire format and the normalized DTOs in
 * `external-vendor.types.ts`. The rest of the pipeline depends only on this
 * abstract class and those types — never on a vendor SDK or raw payload.
 *
 * See `docs/adr/0007-provider-connector-abstraction.md`.
 */
export abstract class ExternalVendorConnector {
  /** The vendor this connector implements. */
  abstract readonly vendor: ExternalVendor;

  /** Feature flags this connector supports. */
  abstract readonly capabilities: VendorCapabilities;

  /**
   * Authenticates an inbound webhook request. AUTH ONLY: runs in the HTTP
   * request path before we return 200, so it must NOT parse the body, perform
   * IO, or cause side effects. Returns whether the request is authentic.
   */
  abstract acceptWebhook(request: WebhookRequest): boolean | Promise<boolean>;

  /**
   * Parses and normalizes a previously-enqueued raw webhook update. Runs in the
   * queue consumer, off the request path. Returns a `NormalizedInboundMessage`,
   * or `null` for updates that should be ignored.
   */
  abstract handleWebhook(
    job: WebhookJob,
  ): Promise<NormalizedInboundMessage | null>;

  /**
   * Downloads media bytes on demand (e.g. a voice note), referenced by a
   * `MediaRef` previously surfaced from `handleWebhook`.
   */
  abstract fetchMedia(ref: MediaRef): Promise<MediaPayload>;

  /**
   * Sends a plain or markdown text message to the target chat. Returns a
   * reference to the created message for tracing and later targeting.
   */
  abstract sendMessage(
    target: SendTarget,
    message: OutboundMessage,
  ): Promise<VendorMessageRef>;

  /**
   * Sends a prompt with inline action buttons (e.g. conflict resolution) to the
   * target chat. Returns a reference to the created message so the caller can
   * later edit its keyboard (e.g. mark a choice confirmed).
   */
  abstract sendActions(
    target: SendTarget,
    actions: OutboundActions,
  ): Promise<VendorMessageRef>;

  /**
   * Acknowledges a callback (e.g. a button tap) so the client stops its loading
   * spinner, optionally showing the user a short toast.
   */
  abstract acknowledgeCallback(
    callbackId: string,
    options?: AcknowledgeOptions,
  ): Promise<void>;

  /**
   * Registers the inbound webhook with the vendor (idempotent), wiring the auth
   * secret that `acceptWebhook` later verifies.
   */
  abstract registerWebhook(url: string): Promise<void>;

  /**
   * Removes the webhook registration with the vendor.
   */
  abstract removeWebhook(): Promise<void>;
}
