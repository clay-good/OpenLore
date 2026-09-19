defmodule Accounts do
  @spec new(map()) :: {:ok, map()}
  def new(attrs) do
    if is_map(attrs) do
      with {:ok, v} <- parse(attrs) do
        v |> format() |> insert()
      end
    else
      raise ArgumentError, "bad"
    end
  end

  defp parse(attrs), do: {:ok, Map.new(attrs)}
  defp format(v), do: v

  defp insert(v) do
    case v do
      nil -> delete(v)
      _ -> send(self(), {:done, inspect(v)})
    end
  end

  def delete(v), do: Enum.map([v], &to_string/1)
  def find(xs) when is_list(xs), do: map(xs)
  def map(xs), do: length(xs)
  def with_default(x \\ fallback()), do: x
  def fallback, do: :none
end

defmodule Multi do
  def walk([]), do: :done
  def walk([h | t]) do
    visit(h)
    walk(t)
  end

  defp visit(x) when is_atom(x), do: x
  defp visit(x), do: normalize(x)
  defp normalize(x), do: x
end
