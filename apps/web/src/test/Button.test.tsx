import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "../atoms/Button";

describe("Button", () => {
  it("fires onClick when an enabled button is clicked", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(
      <Button onClick={handleClick} variant="primary">
        Open Sample Case
      </Button>,
    );

    await user.click(screen.getByRole("button", { name: "Open Sample Case" }));

    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();

    render(
      <Button disabled onClick={handleClick} variant="secondary">
        View
      </Button>,
    );

    const button = screen.getByRole("button", { name: "View" });

    expect(button).toBeDisabled();

    await user.click(button);

    expect(handleClick).not.toHaveBeenCalled();
  });
});

