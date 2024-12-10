import { z } from "zod";
import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

admin.initializeApp();
admin.firestore().settings({ ignoreUndefinedProperties: true });

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
      // receive post request from webhook
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
