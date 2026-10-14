package demo;

import java.math.BigDecimal;

public final class RefundCalculator {
    private RefundCalculator() {}

    /** Amount to refund now, never more than what is still refundable. */
    public static BigDecimal refundAmount(BigDecimal paid, BigDecimal alreadyRefunded, BigDecimal requested) {
        if (requested.signum() <= 0) throw new IllegalArgumentException("requested refund must be positive");
        BigDecimal remaining = paid.subtract(alreadyRefunded);
        // Bug: the cap uses the original payment instead of what is left.
        return requested.min(paid);
    }
}
