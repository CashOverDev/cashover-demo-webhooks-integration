import {z} from "zod";
import * as admin from "firebase-admin";
import {onRequest} from "firebase-functions/v2/https";

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

admin.initializeApp();
admin.firestore().settings({ignoreUndefinedProperties: true});

enum PaymentStatus {
  pending = "pending",
  completed = "completed",
  cancelled = "cancelled",
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
  paymentStatus: z.nativeEnum(PaymentStatus),
  refunded: z.boolean().optional(),
});
export const updatePaymentStatus = onRequest(async (request, response) => {
  try {
    // receive post request from webhook
    const body = request.body;
    const paymentStatus = body.status;
    const isRefunded = body.refunded;
    const orderId = body.metadata?.orderId; // based on the metadata that you provided in the frontend
    const orderDoc = admin.firestore()
    .collection("Orders").doc(orderId);
    const order = await orderDoc.get();

    const orderData = orderDataScheme.parse(order.data());
    orderData.refunded = isRefunded ?? false;
    orderData.paymentStatus = paymentStatus;
    orderData.orderStatus =
      orderData.paymentStatus === PaymentStatus.completed ?
        OrderStatus.delivered :
        OrderStatus.pending;
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
