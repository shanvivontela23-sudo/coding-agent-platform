using Refunds;
using Xunit;

namespace Refunds.Tests;

public class RefundCalculatorTests
{
    [Fact]
    public void FullRefundOfUnrefundedPayment() => Assert.Equal(40.00m, RefundCalculator.RefundAmount(40.00m, 0m, 40.00m));

    [Fact]
    public void RejectsNonPositiveRequest() => Assert.Throws<ArgumentOutOfRangeException>(() => RefundCalculator.RefundAmount(40.00m, 0m, 0m));
}
