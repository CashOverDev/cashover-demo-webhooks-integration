import { z } from "zod";
import * as admin from "firebase-admin";
import * as functions from "firebase-functions";
import * as crypto from "node:crypto";

admin.initializeApp();
admin.firestore().settings({ ignoreUndefinedProperties: true });

const WEBHOOK_SECRET = "h10y2t-Z2D5PHv8K4lLbN6dU-dH8Gvfm"; // securely stored in env

export enum OperationStatus {
  pending = "pending",
  successful = "successful",
  failed = "failed",
  canceled = "canceled",
}
export enum WebhookEvent {
  TransactionRefunded = "transaction_refunded",
  TransactionSuccessful = "transaction_successful",
}
enum OrderStatus {
  pending = "pending",
  cancelled = "cancelled",
  refunded = "shipping",
  delivered = "delivered",
  returned = "returned",
}

const orderDataScheme = z.object({
  items: z.array(
    z.object({
      amount: z.number().min(0),
      quantity: z.number().min(1),
      description: z.string().min(1).optional(),
    })
  ),
  orderId: z.string().min(1),
  totalAmount: z.number().min(0),
  orderStatus: z.nativeEnum(OrderStatus),
  paymentStatus: z.nativeEnum(OperationStatus),
  refunded: z.boolean().optional(),
});

export const updatePaymentStatus = functions
  .runWith({
    enforceAppCheck: false, // Reject requests with missing or invalid App Check tokens.
  })
  .https.onRequest(async (request, response) => {
    try {
      const signatureHeader = request.header("X-Signature");
      const timestampHeader = request.header("X-Signature-Timestamp");

      if (!signatureHeader || !timestampHeader) {
        console.log({ error: "Missing signature headers" });
        response.status(400).json({ error: "Missing signature headers" });
        return;
      }

      const [tPart, v1Part] = signatureHeader.split(",");
      const timestamp = parseInt(tPart.split("=")[1]);
      const receivedSignature = v1Part.split("=")[1];

      // Replay protection: reject if timestamp is older than 5 minutes
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - timestamp) > 300) {
        console.log({ error: "Timestamp too old" });
        response.status(400).json({ error: "Timestamp too old" });
        return;
      }

      // Verify signature
      const rawBody = JSON.stringify(request.body);
      const payloadToSign = `${timestamp}.${rawBody}`;
      const expectedSignature = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(payloadToSign)
        .digest("hex");

      if (
        !crypto.timingSafeEqual(
          Uint8Array.from(Buffer.from(receivedSignature, "hex")),
          Uint8Array.from(Buffer.from(expectedSignature, "hex"))
        )
      ) {
        console.log({ error: "Invalid signature" });
        response.status(403).json({ error: "Invalid signature" });
        return;
      }
      // Webhook is verified, proceed
      const webhookEvent = request.body.event as WebhookEvent;
      const body = request.body;
      const paymentStatus = body.status as OperationStatus;
      const isRefunded = body.refunded as boolean;
      // based on the metadata that you provided in the frontend
      const orderId = body.metadata?.orderId;
      const orderDoc = admin.firestore().collection("Orders").doc(orderId);
      const order = await orderDoc.get();

      const orderData = orderDataScheme.parse(order.data());
      if (webhookEvent === WebhookEvent.TransactionRefunded) {
        orderData.refunded = isRefunded ?? false;
      }
      if (webhookEvent === WebhookEvent.TransactionSuccessful) {
        orderData.paymentStatus = paymentStatus ?? OperationStatus.successful; // transactions do not have a status as they either fail or are successful
        orderData.orderStatus =
          orderData.paymentStatus === OperationStatus.successful
            ? OrderStatus.delivered
            : OrderStatus.pending;
      }
      await orderDoc.update(orderData);
      response.json(orderData).send();
      return;
    } catch (e) {
      console.error(e);
      // set status code to 500 to trigger webhook retries on the cashOver side
      response
        .status(500)
        .json({
          error: "Unable to update payment status",
        })
        .send();
      return;
    }
  });
