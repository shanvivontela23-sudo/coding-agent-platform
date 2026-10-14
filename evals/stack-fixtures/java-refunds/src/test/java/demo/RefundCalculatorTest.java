package demo;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

class RefundCalculatorTest {
    @Test
    void fullRefundOfUnrefundedPayment() {
        assertEquals(new BigDecimal("40.00"), RefundCalculator.refundAmount(new BigDecimal("40.00"), BigDecimal.ZERO, new BigDecimal("40.00")));
    }

    @Test
    void rejectsNonPositiveRequest() {
        assertThrows(IllegalArgumentException.class, () -> RefundCalculator.refundAmount(new BigDecimal("40.00"), BigDecimal.ZERO, BigDecimal.ZERO));
    }
}
